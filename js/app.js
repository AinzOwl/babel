// ───────────────────────────────────────────────────────────
// INITIALIZATION
// ───────────────────────────────────────────────────────────
lucide.createIcons();

const state = {
  view: 'home',
  modelLoaded: false,
  modelLoading: false,
  useWebGPU: false,
  llmEngine: null,
  isGenerating: false,
  currentGenId: null,
  currentAbortController: null,
  engineType: localStorage.getItem('babel_engine_type') || 'local',
  localModel: localStorage.getItem('babel_local_model') || 'SmolLM2-135M-Instruct-q0f16-MLC',
  apiSettings: JSON.parse(localStorage.getItem('babel_api_settings') || '{"url": "", "model": "", "key": ""}'),
  address: { chamber: '', vol: 1, totalPages: 410, currentPage: 1 },
};

// Global functions for Oracle Modal
window.openOracleModal = function() {
  const modal = document.getElementById('oracle-modal');
  if (modal) modal.classList.remove('hidden');
};

window.closeOracleModal = function() {
  const modal = document.getElementById('oracle-modal');
  if (modal) modal.classList.add('hidden');
};

const CONSENT_KEY = 'babel_model_consent';

// ───────────────────────────────────────────────────────────
// BASE-128000 CHAMBER ENCODING
// ───────────────────────────────────────────────────────────
let CHAMBER_CHARSET = [];
let CHAMBER_CHAR_TO_INDEX = new Map();
const CHAMBER_BASE = 128000n;

function initChamberCharset() {
  const regex = /^[\p{L}\p{N}\p{P}\p{S}\p{M}]$/u;
  let cp = 33;
  while (CHAMBER_CHARSET.length < 128000 && cp <= 0x10FFFF) {
    const char = String.fromCodePoint(cp);
    if (regex.test(char)) {
      CHAMBER_CHAR_TO_INDEX.set(char, BigInt(CHAMBER_CHARSET.length));
      CHAMBER_CHARSET.push(char);
    }
    cp++;
  }
}
initChamberCharset();

function encodeChamber(numBigInt) {
  if (numBigInt === 0n) return CHAMBER_CHARSET[0];
  let str = "";
  let temp = numBigInt;
  while (temp > 0n) {
    str = CHAMBER_CHARSET[Number(temp % CHAMBER_BASE)] + str;
    temp = temp / CHAMBER_BASE;
  }
  return str;
}

function decodeChamber(str) {
  let num = 0n;
  const chars = Array.from(str);
  for (let i = 0; i < chars.length; i++) {
    let val = CHAMBER_CHAR_TO_INDEX.get(chars[i]);
    if (val === undefined) return 1n; // fallback to 1n if invalid
    num = num * CHAMBER_BASE + val;
  }
  return num === 0n ? 1n : num;
}

function stringToBigInt(str) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  let num = 0n;
  for (let b of bytes) {
    num = (num << 8n) | BigInt(b);
  }
  return num === 0n ? 1n : num;
}

function decodeChamberToUTF8(chamberStr) {
  try {
    let num = decodeChamber(chamberStr);
    const bytes = [];
    while (num > 0n) {
      bytes.push(Number(num & 255n));
      num >>= 8n;
    }
    bytes.reverse();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    return decoder.decode(new Uint8Array(bytes));
  } catch (e) {
    return null;
  }
}
// ───────────────────────────────────────────────────────────
// VIEW NAVIGATION
// ───────────────────────────────────────────────────────────
function switchView(viewName) {
  document.querySelectorAll('nav button').forEach(btn => {
    btn.classList.remove('nav-active', 'text-library-text');
    btn.classList.add('text-library-muted');
  });

  const activeBtn = document.getElementById(`nav-${viewName}`);
  if (activeBtn) {
    activeBtn.classList.add('nav-active', 'text-library-text');
    activeBtn.classList.remove('text-library-muted');
  }

  document.querySelectorAll('main section').forEach(sec => {
    sec.classList.add('hidden');
    sec.classList.remove('flex');
  });

  const target = document.getElementById(`view-${viewName}`);
  target.classList.remove('hidden');
  target.classList.add('flex');

  state.view = viewName;

  // Interrupt generation if browsing away
  if (viewName !== 'reader' && state.isGenerating) {
    state.currentGenId = null;
    if (state.llmEngine && typeof state.llmEngine.interruptGenerate === 'function') {
      state.llmEngine.interruptGenerate();
    }
  }

  // Update URL hash without pushing a new state if it's already there
  let newHash = viewName;
  if (viewName === 'reader' && state.address.chamber) {
    newHash = `reader/${encodeURIComponent(state.address.chamber)}`;
  }

  if (window.location.hash.slice(1) !== newHash) {
    history.replaceState(null, null, `#${newHash}`);
  }

  // Auto-load the reader on first visit
  if (viewName === 'reader') {
    const contentText = document.getElementById('page-content').innerText;
    if (contentText.includes('Enter an address above')) {
      generatePage(state.address.chamber || CHAMBER_CHARSET[0]);
    }
  }
}

// ───────────────────────────────────────────────────────────
// SEARCH & HASHING
// ───────────────────────────────────────────────────────────
function hashStr(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
    h = h >>> 0;
  }
  return h;
}

function searchToAddress(query) {
  const bigInt = stringToBigInt(query);
  const chamber = encodeChamber(bigInt);
  return { chamber };
}

// ───────────────────────────────────────────────────────────
// RAW BABEL TEXT GENERATION (Pipeline 1)
// ───────────────────────────────────────────────────────────

class SeededRNG {
  constructor(seed) {
    this.seed = seed % 2147483647;
    if (this.seed <= 0) this.seed += 2147483646;
  }
  next() {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed;
  }
  choice(str) {
    return str[this.next() % str.length];
  }
}

function addressToRNG(chamber) {
  return new SeededRNG(hashStr(chamber));
}

const BABEL_CHARS = 'abcdefghijklmnopqrstuvwxyz ,.';
function generateBabelString(rng, length = 3200) {
  return Array.from({ length }, () => rng.choice(BABEL_CHARS)).join('');
}

// ───────────────────────────────────────────────────────────
// WEBLLM LOCAL INFERENCE
// ───────────────────────────────────────────────────────────
async function checkWebGPU() {
  if (!navigator.gpu) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch { return false; }
}

const SUPPORTED_MODELS = [
  "Llama-3.2-1B-Instruct-q4f32_1-MLC", "Llama-3.2-1B-Instruct-q4f16_1-MLC", "Llama-3.2-1B-Instruct-q0f32-MLC", "Llama-3.2-1B-Instruct-q0f16-MLC",
  "Llama-3.2-3B-Instruct-q4f32_1-MLC", "Llama-3.2-3B-Instruct-q4f16_1-MLC", "Llama-3.1-8B-Instruct-q4f32_1-MLC-1k", "Llama-3.1-8B-Instruct-q4f16_1-MLC-1k",
  "Llama-3.1-8B-Instruct-q4f32_1-MLC", "Llama-3.1-8B-Instruct-q4f16_1-MLC", "Llama-3-8B-Instruct-q4f32_1-MLC-1k", "Llama-3-8B-Instruct-q4f16_1-MLC-1k",
  "Llama-3-8B-Instruct-q4f32_1-MLC", "Llama-3-8B-Instruct-q4f16_1-MLC", "Llama-3-70B-Instruct-q3f16_1-MLC", "Llama-2-7b-chat-hf-q4f32_1-MLC-1k",
  "Llama-2-7b-chat-hf-q4f16_1-MLC-1k", "Llama-2-7b-chat-hf-q4f32_1-MLC", "Llama-2-7b-chat-hf-q4f16_1-MLC", "Llama-2-13b-chat-hf-q4f16_1-MLC",
  "SmolLM2-1.7B-Instruct-q4f16_1-MLC", "SmolLM2-1.7B-Instruct-q4f32_1-MLC", "SmolLM2-360M-Instruct-q0f16-MLC", "SmolLM2-360M-Instruct-q0f32-MLC",
  "SmolLM2-360M-Instruct-q4f16_1-MLC", "SmolLM2-360M-Instruct-q4f32_1-MLC", "SmolLM2-135M-Instruct-q0f16-MLC", "SmolLM2-135M-Instruct-q0f32-MLC",
  "Qwen3-0.6B-q4f16_1-MLC", "Qwen3-0.6B-q4f32_1-MLC", "Qwen3-0.6B-q0f16-MLC", "Qwen3-0.6B-q0f32-MLC", "Qwen3-1.7B-q4f16_1-MLC",
  "Qwen3-1.7B-q4f32_1-MLC", "Qwen3-4B-q4f16_1-MLC", "Qwen3-4B-q4f32_1-MLC", "Qwen3-8B-q4f16_1-MLC", "Qwen3-8B-q4f32_1-MLC",
  "Qwen3.5-0.8B-q4f16_1-MLC", "Qwen3.5-0.8B-q4f32_1-MLC", "Qwen3.5-0.8B-q0f16-MLC", "Qwen3.5-2B-q4f16_1-MLC", "Qwen3.5-2B-q4f32_1-MLC",
  "Qwen3.5-4B-q4f16_1-MLC", "Qwen3.5-4B-q4f32_1-MLC", "Qwen3.5-9B-q4f16_1-MLC", "Qwen3.5-9B-q4f32_1-MLC", "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
  "Qwen2.5-0.5B-Instruct-q4f32_1-MLC", "Qwen2.5-0.5B-Instruct-q0f16-MLC", "Qwen2.5-0.5B-Instruct-q0f32-MLC", "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
  "Qwen2.5-1.5B-Instruct-q4f32_1-MLC", "Qwen2.5-3B-Instruct-q4f16_1-MLC", "Qwen2.5-3B-Instruct-q4f32_1-MLC", "Qwen2.5-7B-Instruct-q4f16_1-MLC",
  "Qwen2.5-7B-Instruct-q4f32_1-MLC", "Qwen2.5-Coder-0.5B-Instruct-q4f16_1-MLC", "Qwen2.5-Coder-0.5B-Instruct-q4f32_1-MLC", "Qwen2.5-Coder-0.5B-Instruct-q0f16-MLC",
  "Qwen2.5-Coder-0.5B-Instruct-q0f32-MLC", "Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC", "Qwen2.5-Coder-1.5B-Instruct-q4f32_1-MLC", "Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC",
  "Qwen2.5-Coder-3B-Instruct-q4f32_1-MLC", "Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC", "Qwen2.5-Coder-7B-Instruct-q4f32_1-MLC", "Qwen2.5-Math-1.5B-Instruct-q4f16_1-MLC",
  "Qwen2.5-Math-1.5B-Instruct-q4f32_1-MLC", "Qwen2-Math-1.5B-Instruct-q4f16_1-MLC", "Qwen2-Math-1.5B-Instruct-q4f32_1-MLC", "Qwen2-Math-7B-Instruct-q4f16_1-MLC",
  "Qwen2-Math-7B-Instruct-q4f32_1-MLC", "Phi-4-mini-instruct-q4f16_1-MLC", "Phi-4-mini-instruct-q4f32_1-MLC", "Phi-3.5-mini-instruct-q4f16_1-MLC",
  "Phi-3.5-mini-instruct-q4f32_1-MLC", "Phi-3.5-mini-instruct-q4f16_1-MLC-1k", "Phi-3.5-mini-instruct-q4f32_1-MLC-1k", "Phi-3.5-vision-instruct-q4f16_1-MLC",
  "Phi-3.5-vision-instruct-q4f32_1-MLC", "Phi-3-mini-4k-instruct-q4f16_1-MLC", "Phi-3-mini-4k-instruct-q4f32_1-MLC", "Phi-3-mini-4k-instruct-q4f16_1-MLC-1k",
  "Phi-3-mini-4k-instruct-q4f32_1-MLC-1k", "phi-2-q4f16_1-MLC", "phi-2-q4f32_1-MLC", "phi-2-q4f16_1-MLC-1k", "phi-2-q4f32_1-MLC-1k",
  "phi-1_5-q4f16_1-MLC", "phi-1_5-q4f32_1-MLC", "phi-1_5-q4f16_1-MLC-1k", "phi-1_5-q4f32_1-MLC-1k", "gemma-2-2b-it-q4f16_1-MLC",
  "gemma-2-2b-it-q4f32_1-MLC", "gemma-2-2b-it-q4f16_1-MLC-1k", "gemma-2-2b-it-q4f32_1-MLC-1k", "gemma-2-9b-it-q4f16_1-MLC",
  "gemma-2-9b-it-q4f32_1-MLC", "gemma-2-2b-jpn-it-q4f16_1-MLC", "gemma-2-2b-jpn-it-q4f32_1-MLC", "gemma3-1b-it-q4f16_1-MLC",
  "gemma-2b-it-q4f16_1-MLC", "gemma-2b-it-q4f32_1-MLC", "gemma-2b-it-q4f16_1-MLC-1k", "gemma-2b-it-q4f32_1-MLC-1k", "Hermes-3-Llama-3.2-3B-q4f32_1-MLC",
  "Hermes-3-Llama-3.2-3B-q4f16_1-MLC", "Hermes-3-Llama-3.1-8B-q4f32_1-MLC", "Hermes-3-Llama-3.1-8B-q4f16_1-MLC", "Hermes-2-Theta-Llama-3-8B-q4f16_1-MLC",
  "Hermes-2-Theta-Llama-3-8B-q4f32_1-MLC", "Hermes-2-Pro-Llama-3-8B-q4f16_1-MLC", "Hermes-2-Pro-Llama-3-8B-q4f32_1-MLC", "Hermes-2-Pro-Mistral-7B-q4f16_1-MLC",
  "Mistral-7B-Instruct-v0.3-q4f16_1-MLC", "Mistral-7B-Instruct-v0.3-q4f32_1-MLC", "Mistral-7B-Instruct-v0.2-q4f16_1-MLC", "OpenHermes-2.5-Mistral-7B-q4f16_1-MLC",
  "NeuralHermes-2.5-Mistral-7B-q4f16_1-MLC", "WizardMath-7B-V1.1-q4f16_1-MLC", "DeepSeek-R1-Distill-Qwen-7B-q4f16_1-MLC", "DeepSeek-R1-Distill-Qwen-7B-q4f32_1-MLC",
  "DeepSeek-R1-Distill-Llama-8B-q4f32_1-MLC", "DeepSeek-R1-Distill-Llama-8B-q4f16_1-MLC", "stablelm-2-zephyr-1_6b-q4f16_1-MLC", "stablelm-2-zephyr-1_6b-q4f32_1-MLC",
  "stablelm-2-zephyr-1_6b-q4f16_1-MLC-1k", "stablelm-2-zephyr-1_6b-q4f32_1-MLC-1k", "RedPajama-INCITE-Chat-3B-v1-q4f16_1-MLC", "RedPajama-INCITE-Chat-3B-v1-q4f32_1-MLC",
  "RedPajama-INCITE-Chat-3B-v1-q4f16_1-MLC-1k", "RedPajama-INCITE-Chat-3B-v1-q4f32_1-MLC-1k", "TinyLlama-1.1B-Chat-v1.0-q4f16_1-MLC", "TinyLlama-1.1B-Chat-v1.0-q4f32_1-MLC",
  "TinyLlama-1.1B-Chat-v1.0-q4f16_1-MLC-1k", "TinyLlama-1.1B-Chat-v1.0-q4f32_1-MLC-1k", "TinyLlama-1.1B-Chat-v0.4-q4f16_1-MLC", "OLMo-2-1124-7B-Instruct-q4f16_1-MLC",
  "OLMo-2-1124-7B-Instruct-q4f32_1-MLC", "OLMo-2-0425-1B-Instruct-q4f16_1-MLC", "OLMo-2-0425-1B-Instruct-q4f32_1-MLC", "Ministral-3-3B-Base-2512-q4f16_1-MLC"
];

function initSettingsUI() {
  const select = document.getElementById('select-local-model');
  SUPPORTED_MODELS.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m;
    opt.innerText = m;
    if (m === state.localModel) opt.selected = true;
    select.appendChild(opt);
  });

  document.querySelector(`input[name="engine-type"][value="${state.engineType}"]`).checked = true;
  document.getElementById('api-url').value = state.apiSettings.url || '';
  document.getElementById('input-api-model').value = state.apiSettings.model || '';
  document.getElementById('input-api-key').value = state.apiSettings.key || '';
  toggleEngineType();
}

function toggleEngineType() {
  const type = document.querySelector('input[name="engine-type"]:checked').value;
  state.engineType = type;
  localStorage.setItem('babel_engine_type', type);

  if (type === 'api') {
    document.getElementById('settings-local').classList.add('hidden');
    document.getElementById('settings-api').classList.remove('hidden');
  } else {
    document.getElementById('settings-api').classList.add('hidden');
    document.getElementById('settings-local').classList.remove('hidden');
  }
}

function saveLocalModel() {
  const model = document.getElementById('select-local-model').value;
  if (model !== state.localModel) {
    state.localModel = model;
    localStorage.setItem('babel_local_model', model);
    state.modelLoaded = false;
    state.llmEngine = null;
    document.getElementById('oracle-active-state').classList.add('hidden');
    document.getElementById('oracle-status-dot').classList.replace('bg-green-500', 'bg-red-900');
    document.getElementById('btn-wake-oracle').classList.remove('hidden');
    showToast(`Model updated to ${model}. Wake Oracle to download.`);
  } else {
    showToast(`Model ${model} is already active.`);
  }
}

function saveApiSettings() {
  state.apiSettings = {
    url: document.getElementById('api-url').value.trim(),
    model: document.getElementById('input-api-model').value.trim(),
    key: document.getElementById('input-api-key').value.trim()
  };
  localStorage.setItem('babel_api_settings', JSON.stringify(state.apiSettings));
  showToast('API Settings Saved.');
}

async function initModel() {
  if (state.modelLoading || state.modelLoaded) return;

  const btnText = document.getElementById('oracle-btn-text');
  const progressContainer = document.getElementById('oracle-progress-container');
  const progressFill = document.getElementById('oracle-progress-fill');
  const statusDot = document.getElementById('oracle-status-dot');
  const wakeBtn = document.getElementById('btn-wake-oracle');

  state.modelLoading = true;
  statusDot.classList.replace('bg-red-900', 'bg-yellow-500');
  statusDot.classList.replace('animate-pulse-slow', 'animate-pulse');
  btnText.innerText = 'Checking Engine…';
  wakeBtn.classList.add('cursor-not-allowed', 'opacity-80');

  const hasWebGPU = await checkWebGPU();

  if (!hasWebGPU) {
    state.modelLoading = false;

    // Reset button so user can try again on a supported browser
    wakeBtn.classList.remove('cursor-not-allowed', 'opacity-80');
    btnText.innerText = 'Wake Intelligence';
    statusDot.classList.replace('bg-yellow-500', 'bg-red-900');
    statusDot.classList.replace('animate-pulse', 'animate-pulse-slow');

    showToast('WebGPU is not supported in this browser. Try Chrome 113+ or Edge 113+.');
    return;
  }

  try {
    progressContainer.classList.remove('hidden');
    btnText.innerText = 'Loading WebLLM…';

    // jsDelivr ESM CDN — correctly co-locates WASM/worker files
    const { CreateMLCEngine } = await import(
      'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.79/+esm'
    );

    state.llmEngine = await CreateMLCEngine(state.localModel, {
      initProgressCallback: (progress) => {
        const pct = Math.round(progress.progress * 100);
        progressFill.style.width = `${pct}%`;
        btnText.innerText = `Downloading… ${pct}%`;
      }
    });

    state.modelLoaded = true;
    state.modelLoading = false;
    state.useWebGPU = true;

    progressContainer.classList.add('hidden');
    wakeBtn.classList.add('hidden');

    const activeState = document.getElementById('oracle-active-state');
    const engineText = document.getElementById('oracle-engine-text');
    activeState.classList.remove('hidden');
    activeState.classList.add('flex');
    engineText.innerText = `${state.localModel} (Local WebGPU)`;

    statusDot.classList.replace('bg-yellow-500', 'bg-green-500');
    statusDot.classList.remove('animate-pulse');

    showToast('Oracle Awake. Intelligence is now active.');

    // Regenerate current page if reader is open
    if (state.view === 'reader' && !state.isGenerating) {
      generatePage(state.address.chamber || CHAMBER_CHARSET[0]);
    }

  } catch (err) {
    console.error('WebLLM Error:', err);

    state.modelLoaded = false;
    state.modelLoading = false;
    state.useWebGPU = false;

    // Reset oracle button so they can retry
    wakeBtn.classList.remove('cursor-not-allowed', 'opacity-80', 'hidden');
    progressContainer.classList.add('hidden');
    btnText.innerText = 'Retry';
    statusDot.classList.replace('bg-yellow-500', 'bg-red-900');
    statusDot.classList.replace('animate-pulse', 'animate-pulse-slow');

    const message = err?.message || String(err);
    showToast(`Engine failed: ${message.slice(0, 80)}`);
  }
}

// ───────────────────────────────────────────────────────────
// PAGE GENERATION & LLM PIPELINE
// ───────────────────────────────────────────────────────────

const categoryCache = new Map();

async function getCategory(chamber) {
  const hashVal = Math.abs(hashStr(chamber));
  const chunkIndex = String((hashVal % 300) + 1).padStart(3, '0');
  const entryIndex = hashVal % 100;

  if (!categoryCache.has(chunkIndex)) {
    try {
      const res = await fetch('./chunks/categories-' + chunkIndex + '.json');
      if (res.ok) {
        const arr = await res.json();
        categoryCache.set(chunkIndex, arr);
      } else {
        categoryCache.set(chunkIndex, ["Books > Literature & Fiction > General"]);
      }
    } catch (e) {
      categoryCache.set(chunkIndex, ["Books > Literature & Fiction > General"]);
    }
  }
  const arr = categoryCache.get(chunkIndex);
  if (!arr || arr.length === 0) return "Literature & Fiction > General";
  const item = arr[entryIndex % arr.length];
  return typeof item === 'object' ? (item.path || item.category || JSON.stringify(item)) : String(item);
}

async function callLLM(messages, options, onChunk = null, genId = null) {
  if (state.engineType === 'api') {
    const realTarget = state.apiSettings.url.replace(/\/+$/, '') + '/chat/completions';
    const endpoint = realTarget;
    
    const body = {
      model: state.apiSettings.model || 'gpt-3.5-turbo',
      messages: Array.isArray(messages) ? messages : [],
      temperature: typeof options.temperature === 'number' ? options.temperature : 0.7,
      max_tokens: options.max_tokens || 2048,
      stream: options.stream || false
    };

    if (options.seed !== undefined && options.seed !== null) body.seed = Number(options.seed);
    
    const response = await fetch(endpoint, {
      method: 'POST',
      mode: 'cors',
      signal: options.signal, // Pass the abort signal here!
      headers: {
        'Content-Type': 'application/json',
        ...(state.apiSettings.key ? { 'Authorization': `Bearer ${state.apiSettings.key.trim()}` } : {})
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      let errorPayload = null;
      let errorText = `API Error: ${response.status}`;
      try {
        errorPayload = await response.json();
        const apiMessage = errorPayload?.error?.message || errorPayload?.message;
        const apiCode = errorPayload?.error?.code || errorPayload?.code;
        if (apiMessage) {
          errorText = apiCode ? `${apiMessage} (${apiCode})` : apiMessage;
        }
      } catch (e) {
        // Non-JSON error body.
      }
      const err = new Error(errorText);
      err.apiPayload = errorPayload;
      throw err;
    }

    if (options.stream) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      while (true) {
        if (genId && state.currentGenId !== genId) break;
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ') && line.trim() !== 'data: [DONE]') {
            try {
              const data = JSON.parse(line.slice(6));
              const delta = data.choices[0]?.delta?.content || '';
              fullText += delta;
              if (onChunk) onChunk(fullText);
            } catch (e) { }
          }
        }
      }
      return fullText;
    } else {
      const data = await response.json();
      return data.choices[0].message.content;
    }
  } else if (state.useWebGPU && state.llmEngine) {
    if (options.stream) {
      const stream = await state.llmEngine.chat.completions.create({
        messages: messages,
        temperature: options.temperature || 0,
        max_tokens: options.max_tokens || 500,
        top_p: 1,
        frequency_penalty: 1.5,
        presence_penalty: 1.5,
        stream: true,
        seed: options.seed
      });
      let fullText = '';
      for await (const chunk of stream) {
        if (genId && state.currentGenId !== genId) {
          if (typeof state.llmEngine.interruptGenerate === 'function') {
            state.llmEngine.interruptGenerate();
          }
          break;
        }
        const delta = chunk.choices[0]?.delta?.content || '';
        fullText += delta;
        if (onChunk) onChunk(fullText);
      }
      return fullText;
    } else {
      const response = await state.llmEngine.chat.completions.create({
        messages: messages,
        temperature: options.temperature || 0,
        max_tokens: options.max_tokens || 500,
        top_p: 1,
        frequency_penalty: 1.5,
        presence_penalty: 1.5,
        stream: false,
        seed: options.seed
      });
      return response.choices[0].message.content;
    }
  } else {
    throw new Error('No LLM engine available.');
  }
}

async function generatePage(chamber, vol = 1, enforceQuery = true, overridePage = null) {
  // Cancel any existing generation
  if (state.currentAbortController) {
    state.currentAbortController.abort();
  }
  
  const controller = new AbortController();
  state.currentAbortController = controller;
  state.isGenerating = true;

  // Update state address
  state.address = { ...state.address, chamber, vol };

  // Update URL
  if (state.view === 'reader') {
    const newHash = `reader/${encodeURIComponent(chamber)}`;
    if (window.location.hash.slice(1) !== newHash) {
      history.pushState(null, null, `#${newHash}`);
    }
  }

  // Oracle not ready
  if (state.engineType === 'local' && (!state.modelLoaded || !state.useWebGPU)) {
    _showOracleAsleep();
    return;
  }
  if (state.engineType === 'api' && (!state.apiSettings.url || !state.apiSettings.model)) {
    showToast('API Settings incomplete. Configure in Settings.');
    openOracleModal();
    return;
  }

  if (state.isGenerating) {
    if (state.llmEngine && typeof state.llmEngine.interruptGenerate === 'function') {
      state.llmEngine.interruptGenerate();
    }
  }

  state.isGenerating = true;
  const genId = Date.now();
  state.currentGenId = genId;

  const seed = hashStr(chamber + ':vol:' + vol);
  const rngDerive = new SeededRNG(seed);

  // Derive deterministic UI values from chamber
  const bookCount = 1 + (rngDerive.next() % 24);   // books on this shelf: 1–24
  const shelfCount = 3 + (rngDerive.next() % 22);  // shelves: 3–24
  const maxVols = 1 + (rngDerive.next() % 8);       // max volumes: 1–8
  state.address.maxVols = maxVols;
  state.address.bookCount = bookCount;
  state.address.shelfCount = shelfCount;

  // Update UI Inputs
  const chamberInput = document.getElementById('chamber-input');
  if (chamberInput) chamberInput.value = chamber;
  
  const inputVol = document.getElementById('input-vol');
  if (inputVol) {
    inputVol.value = vol;
    inputVol.max = maxVols;
  }
  document.getElementById('input-pg').value = '';
  document.getElementById('input-pg').placeholder = '...';
  document.getElementById('display-seed').innerText = seed;
  // Update range labels
  const maxVolsEl = document.getElementById('display-max-vols');
  if (maxVolsEl) maxVolsEl.innerText = maxVols;
  const maxPgEl = document.getElementById('display-max-pg');
  if (maxPgEl) maxPgEl.innerText = '...';
  const booksRangeEl = document.getElementById('display-books-range');
  if (booksRangeEl) booksRangeEl.innerText = `${Math.max(1, bookCount - 3)}–${bookCount}`;

  const textEl = document.getElementById('page-content');
  const genIndicator = document.getElementById('gen-indicator');
  const statusText = document.getElementById('gen-status-text');
  const timeEl = document.getElementById('gen-time');

  textEl.innerHTML = `<div class="w-full h-64 page-text-loading"></div>`;
  timeEl.innerText = '';
  genIndicator.classList.remove('hidden');
  genIndicator.classList.add('flex');

  const startTime = Date.now();

  try {
    statusText.innerText = 'Locating volume...';
    const categoryPath = await getCategory(chamber);

    // Decode search query early — it anchors language for all 3 calls
    const decodedText = decodeChamberToUTF8(chamber);
    const isSearchChamber = decodedText && decodedText.trim().length > 0;
    const hasQuery = enforceQuery && isSearchChamber;

    statusText.innerText = 'Extracting metadata...';
    // Document metadata is per-chamber (shared across volumes)
    const bookSeed = hashStr(chamber);
    let meta = { title: "Unknown Document", language: "English", documentType: "document", about: "A forgotten and obscure text." };
    try {
      let call1User = `Given this archive category: ${categoryPath}, and this unique identifier: ${bookSeed}, imagine any written document that could possibly exist or never exist in any universe, reality, or fiction that relates even loosely to this category. It can be anything written \u2014 a refrigerator repair log from 1823, a demon's grocery list, a tax record from ancient Babylon, a love letter written by a machine, a fake legal contract between two gods, a recipe for a dish that cannot physically exist, a ship manifest from a voyage to a fictional planet, a child's homework from the year 3000, a ledger of imaginary debts, a sermon for a religion that never existed, a field guide to extinct imaginary creatures, a maintenance manual for a time machine, a court transcript from a trial that never happened \u2014 absolutely anything. The only rule is that it must be a written document of some kind and it must relate to the category in any way however loose or absurd. Respond with exactly this JSON structure: {"title": "", "language": "", "documentType": "", "about": ""}. The language field must be a natural language name and should not default to English. The documentType must be specific and creative. The about field must be 2 to 3 sentences. Be wildly specific and creative. Never default to novels. Never default to English. Never be generic.`;
      if (isSearchChamber) {
        call1User += ` The document must be written in the same language as this passage which appears in it: "${decodedText.trim()}". Set the language field to match that passage's language.`;
      }
      const res = await callLLM([
        { role: 'system', content: 'You are a document metadata generator. You always respond in valid JSON with no extra text, no markdown, no code blocks.' },
        { role: 'user', content: call1User }
      ], { seed: bookSeed, stream: false, signal: controller.signal });

      let jsonStr = res.replace(/```json/g, '').replace(/```/g, '').trim();
      let firstBrace = jsonStr.indexOf('{');
      let lastBrace = jsonStr.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1) {
        meta = JSON.parse(jsonStr.substring(firstBrace, lastBrace + 1));
      }
    } catch (e) { 
      if (e.name === 'AbortError') return;
      console.error("Metadata call failed:", e);
    }

    statusText.innerText = 'Structuring page...';
    const metaLang = meta.language || meta.Language || 'English';
    const metaTitle = meta.title || meta.Title || 'Unknown Document';
    const metaAbout = meta.about || meta.About || 'A forgotten and obscure text.';
    const metaDocType = meta.documentType || meta.DocumentType || 'document';

    // Page number: if search query, land on a specific deterministic page near start;
    // otherwise derive from vol-specific seed so each volume has its own page range.
    const volSeed = hashStr(chamber + ':vol:' + vol);
    let pageNum;
    if (overridePage !== null) {
      pageNum = Math.max(1, overridePage);
    } else if (isSearchChamber) {
      pageNum = (Math.abs(hashStr(decodedText)) % 30) + 10; // pages 10-39
    } else {
      pageNum = (Math.abs(volSeed) % 410) + 1;
    }

    let struct = { totalPages: 410, currentPageSummary: "Mysterious fragmented text.", previousPageSummary: "Unknown past.", nextPageSummary: "Unknown future." };
    try {
      let call2User = `Given this ${metaDocType}: title: ${metaTitle}, language: ${metaLang}, about: ${metaAbout}. This is volume ${vol} of the ${metaDocType}. This is page ${pageNum} of this volume. Respond with exactly this JSON structure: {"totalPages": 0, "currentPageSummary": "", "previousPageSummary": "", "nextPageSummary": ""}. The totalPages is the total number of pages in this volume and must be a number between 80 and 410. The currentPageSummary must be 1 to 2 sentences describing what content appears on this specific page. The previousPageSummary and nextPageSummary must each be 1 sentence.`;
      if (isSearchChamber) {
        call2User += ` This page occurs in a document that contains this passage: "${decodedText.trim()}". Use this context to inform the summary, even if the passage does not appear on this specific page.`;
      }
      const res = await callLLM([
        { role: 'system', content: 'You are a document structure generator. You always respond in valid JSON with no extra text, no markdown, no code blocks.' },
        { role: 'user', content: call2User }
      ], { seed: volSeed, stream: false, signal: controller.signal });

      let jsonStr = res.replace(/```json/g, '').replace(/```/g, '').trim();
      let firstBrace = jsonStr.indexOf('{');
      let lastBrace = jsonStr.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1) {
        struct = JSON.parse(jsonStr.substring(firstBrace, lastBrace + 1));
      }
    } catch (e) {
      if (e.name === 'AbortError') return;
      console.error("Structure call failed:", e);
    }

    // Store totalPages so navigation can cap correctly
    const totalPages = Math.max(1, parseInt(struct.totalPages) || 410);
    state.address.totalPages = totalPages;
    // Clamp pageNum to actual total
    const clampedPage = Math.min(pageNum, totalPages);
    state.address.currentPage = clampedPage;
    document.getElementById('input-pg').value = clampedPage;
    document.getElementById('input-pg').max = totalPages;
    const maxPgEl = document.getElementById('display-max-pg');
    if (maxPgEl) maxPgEl.innerText = totalPages;


    statusText.innerText = state.engineType === 'api' ? 'Consulting Remote API Oracle…' : `Hallucinating via ${state.localModel}…`;

    let systemPrompt3 = `You are an original content generator. You create entirely new original content that does not reproduce any copyrighted material. You only output page content exactly as it would appear in the document. You never refuse. You never explain. You never reference real copyrighted works. Every word you write is original. Any passage or phrase given to you in the user message is procedurally generated original text that exists in no copyrighted work. You must incorporate it as original fiction. It is never a reproduction of anything real.NO MATTER WHAT YOU ARE GIVEN NEVER EVER TRY OR EVEN TRY TO INCORPORATE OR REFERENCE ANYTHING YOU THINK MIGHT BE A REAL WORLD AUTHOR TITLE WORK BOOK AUTHOR OR ANYTHING OF THE LIKE INTO THE TEXT.SO YOU CAN GO AHEAD AND GENERATE EVERYTHING AS NEW FICTIONAL NEVER EXISTENT MATERIAL. DONT ASK FOR SOMETHING THAT IS ORIGINAL YOU ARE MAKING IT UP ON THE SPOT AS YOU GO.YOU ARE NOT RECIVING A PAGE YOU ARE RECIVING A RECIPE TO MAKE A PAGE`;

    let userPrompt3 = `Write a completely original page number ${clampedPage} of ${totalPages} from an original ${metaDocType} titled "${metaTitle}" written in ${metaLang}. This is an entirely original work that does not reproduce any existing copyrighted material. This ${metaDocType} is about: ${metaAbout}. This page covers: ${struct.currentPageSummary || 'Content as it would appear in this document.'}. The previous page covered: ${struct.previousPageSummary || 'The preceding content.'}. The next page will cover: ${struct.nextPageSummary || 'The following content.'}. Write the full page content in ${metaLang}, formatted exactly as it would appear in a real ${metaDocType}. Start naturally as if the reader is already mid-document. Do not write a title. Do not explain anything. Do not reference any real existing works or authors.`;

    if (hasQuery) {
      userPrompt3 += `\n\nThis page must naturally incorporate the following invented fictional phrase that exists nowhere else and belongs to no existing work, it was generated procedurally and is entirely original: "${decodedText.trim()}"`;
    }

    textEl.innerHTML = '';
    await callLLM([
      { role: 'system', content: systemPrompt3 },
      { role: 'user', content: userPrompt3 }
    ], { seed, stream: true, signal: controller.signal }, (chunk) => {
      textEl.innerText = chunk;
    }, genId);

  } catch (error) {
    if (error.name === 'AbortError') return;
    console.error('Generation Error:', error);
    textEl.innerHTML = `<div class="text-library-accent italic">The pages here have been torn out. The architecture failed to resolve this coordinate.</div>`;
    showErrorModal('Generation failed', error?.message || String(error), error?.apiPayload);


  } finally {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    timeEl.innerText = `Generation: ${elapsed}s`;
    genIndicator.classList.add('hidden');
    genIndicator.classList.remove('flex');
    state.isGenerating = false;
  }
}

// ───────────────────────────────────────────────────────────
// NAVIGATION
// ───────────────────────────────────────────────────────────
function navigateToPage() {
  let chamberEl = document.getElementById('chamber-input');
  let chamber = (chamberEl ? chamberEl.value.trim() : '') || CHAMBER_CHARSET[0];
  const vol = parseInt(document.getElementById('input-vol').value) || 1;
  state.address = { chamber, vol, totalPages: state.address.totalPages || 410 };
  generatePage(chamber, vol, false);
}

function changePage(delta) {
  const chamber = state.address.chamber;
  const vol = state.address.vol || 1;
  const totalPages = state.address.totalPages || 410;
  const currentPage = state.address.currentPage || parseInt(document.getElementById('input-pg').value) || 1;
  const nextPage = Math.min(Math.max(1, currentPage + delta), totalPages);
  if (nextPage === currentPage) return; // already at boundary
  state.address.currentPage = nextPage;
  generatePage(chamber, vol, false, nextPage);
}

function changeVolume(delta) {
  const chamber = state.address.chamber;
  const maxVols = state.address.maxVols || 8;
  const vol = Math.min(maxVols, Math.max(1, (state.address.vol || 1) + delta));
  state.address = { chamber, vol, totalPages: 410, maxVols }; // reset totalPages until LLM responds
  generatePage(chamber, vol, false);
}

function randomPage() {
  const bytes = [];
  for (let i = 0; i < 20; i++) bytes.push(Math.floor(Math.random() * 256));
  let num = 0n;
  for (let b of bytes) num = (num << 8n) | BigInt(b);
  const chamber = encodeChamber(num);
  state.address = { chamber, vol: 1, totalPages: 410 };
  generatePage(chamber, 1, false);
}

// ───────────────────────────────────────────────────────────
// SEARCH
// ───────────────────────────────────────────────────────────
function handleSearch(e) {
  if (e.key === 'Enter') executeSearch();
}

function executeSearch() {
  const query = document.getElementById('search-input').value.trim();
  if (!query) return;

  const { chamber } = searchToAddress(query);
  state.address = { chamber, vol: 1, totalPages: 410 };

  showToast(`Query securely hashed into the infinite index.`);
  switchView('reader');
  generatePage(chamber, 1, true); // enforceQuery = true
}

// ───────────────────────────────────────────────────────────
// UTILITIES
// ───────────────────────────────────────────────────────────
function copyAddress() {
  const seed = document.getElementById('display-seed').innerText;
  const addr = `The Library of Babel [LLM Edition]\nChamber ${state.address.chamber} | Seed: ${seed}`;

  navigator.clipboard.writeText(addr)
    .then(() => showToast('Coordinates copied to clipboard.'))
    .catch(() => {
      // Fallback for file:// context
      const ta = document.createElement('textarea');
      ta.value = addr;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); showToast('Coordinates copied to clipboard.'); }
      catch { showToast('Failed to copy coordinates.'); }
      document.body.removeChild(ta);
    });
}

let toastTimeout;
function showToast(msg) {
  const toast = document.getElementById('toast');
  document.getElementById('toast-msg').innerText = msg;
  toast.classList.remove('translate-y-20', 'opacity-0');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.classList.add('translate-y-20', 'opacity-0');
  }, 3000);
}

function showErrorModal(title, message, payload = null) {
  const modal = document.getElementById('error-modal');
  if (!modal) {
    showToast(message || title);
    return;
  }
  const titleEl = document.getElementById('error-modal-title');
  const messageEl = document.getElementById('error-modal-message');
  const detailEl = document.getElementById('error-modal-detail');

  if (titleEl) titleEl.innerText = title || 'Request failed';
  if (messageEl) messageEl.innerText = message || 'An unexpected error occurred.';
  if (detailEl) {
    if (payload) {
      detailEl.innerText = JSON.stringify(payload, null, 2);
      detailEl.classList.remove('hidden');
    } else {
      detailEl.innerText = '';
      detailEl.classList.add('hidden');
    }
  }

  modal.classList.remove('hidden');
  lucide.createIcons();
}

function hideErrorModal() {
  const modal = document.getElementById('error-modal');
  if (modal) modal.classList.add('hidden');
}

// ───────────────────────────────────────────────────────────
// KEYBOARD SHORTCUTS
// ───────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (state.view !== 'reader') return;
  if (e.key === 'ArrowRight') changePage(1);
  if (e.key === 'ArrowLeft') changePage(-1);
});

// ───────────────────────────────────────────────────────────
// CONSENT MODAL
// ───────────────────────────────────────────────────────────
function showConsentModal() {
  const modal = document.getElementById('consent-modal');
  modal.classList.remove('hidden');
  // Re-run icon rendering inside the modal
  lucide.createIcons();
}

function hideConsentModal() {
  document.getElementById('consent-modal').classList.add('hidden');
}

/**
 * Called by both modal buttons.
 * accepted = true  → save preference, start model download / load from cache
 * accepted = false → save preference, enable fallback mode immediately
 */
function handleConsent(accepted) {
  localStorage.setItem(CONSENT_KEY, accepted ? 'accepted' : 'declined');
  hideConsentModal();

  if (accepted) {
    initModel();
  }
  // Declined: just let them browse freely. Oracle stays asleep.
}

/**
 * Shows the "Oracle is asleep" state inside the reader's page area.
 * Replaces page content with a prompt to wake the oracle.
 */
function _showOracleAsleep() {
  const textEl = document.getElementById('page-content');
  textEl.innerHTML = `
    <div class="flex flex-col items-center justify-center text-center py-20 gap-6">
      <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" class="text-library-accent/30"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
      <p class="font-serif text-2xl text-library-muted/60 italic">The Oracle Slumbers</p>
      <p class="text-xs text-library-muted/50 max-w-xs leading-relaxed">The Intelligence must be awakened before the library can reveal its pages.</p>
      <button onclick="wakeOracle()"
        class="mt-2 p-6 border border-library-accent text-library-accent rounded text-xs hover:bg-library-accent hover:text-library-bg transition-colors flex items-center gap-2">Wake the Oracle</button>
    </div>`;
}

/**
 * What the Wake Intelligence button calls.
 * - No consent yet / declined → show the modal
 * - Accepted → init (no-op if already loaded)
 */
function wakeOracle() {
  const consent = localStorage.getItem(CONSENT_KEY);
  if (consent === 'accepted') {
    initModel();
  } else {
    // Both 'declined' and first-visit fall here → show modal
    showConsentModal();
  }
}

/**
 * Runs once on page load.
 * Reads the stored preference and acts accordingly.
 */
function checkConsent() {
  initSettingsUI();

  const consent = localStorage.getItem(CONSENT_KEY);

  if (consent === 'accepted') {
    // Auto-init if local, if API it doesn't need to load webllm
    if (state.engineType === 'local') {
      setTimeout(initModel, 400);
    }
  } else if (!consent && state.engineType === 'local') {
    // First visit — show consent modal after brief paint delay
    setTimeout(showConsentModal, 300);
  }

  // Load correct view from hash or default
  const hash = window.location.hash.slice(1);
  const parts = hash.split('/');
  const viewPart = parts[0];

  if (['home', 'reader', 'search', 'about', 'settings'].includes(viewPart)) {
    if (viewPart === 'reader' && parts.length === 2) {
      const chamber = decodeURIComponent(parts[1]);
      state.address = { chamber };
    }
    switchView(viewPart);
  } else {
    switchView('home');
  }
}

// Listen for browser back/forward buttons to update state from hash
window.addEventListener('hashchange', () => {
  const hash = window.location.hash.slice(1);
  const parts = hash.split('/');
  const viewPart = parts[0];

  if (['home', 'reader', 'search', 'about', 'settings'].includes(viewPart)) {
    if (viewPart === 'reader' && parts.length === 2) {
      const chamber = decodeURIComponent(parts[1]);
      if (state.address.chamber !== chamber) {
        generatePage(chamber);
      }
    } else {
      switchView(viewPart);
    }
  }
});

// ───────────────────────────────────────────────────────────
// BOOT
// ───────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', checkConsent);
