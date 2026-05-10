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
  address: { chamber: '0' },
  isGenerating: false,
  currentGenId: null,
  engineType: localStorage.getItem('babel_engine_type') || 'local',
  localModel: localStorage.getItem('babel_local_model') || 'SmolLM2-135M-Instruct-q0f16-MLC',
  apiSettings: JSON.parse(localStorage.getItem('babel_api_settings') || '{"url": "", "model": "", "key": ""}'),
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
  } catch(e) {
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
  document.getElementById('input-api-url').value = state.apiSettings.url;
  document.getElementById('input-api-model').value = state.apiSettings.model;
  document.getElementById('input-api-key').value = state.apiSettings.key;

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
    url: document.getElementById('input-api-url').value.trim(),
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
// PAGE GENERATION
// ───────────────────────────────────────────────────────────
async function generatePage(chamber) {
  // Update state address
  state.address = { chamber };

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
  if (state.engineType === 'api' && (!state.apiSettings.url || !state.apiSettings.model || !state.apiSettings.key)) {
    showToast('API Settings incomplete. Configure in Settings.');
    switchView('settings');
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

  const seed = hashStr(chamber);
  const rngDerive = new SeededRNG(seed);
  
  // Derive deterministic UI values from chamber
  const bookCount = 1 + (rngDerive.next() % 24);
  const shelfCount = 3 + (rngDerive.next() % 22);
  const volCount = 1 + (rngDerive.next() % 8);
  const pageCount = 1 + (rngDerive.next() % 410);

  // Update UI Inputs
  document.getElementById('input-hex').value = chamber;
  document.getElementById('input-wall').value = bookCount;
  document.getElementById('input-shelf').value = shelfCount;
  document.getElementById('input-vol').value = volCount;
  document.getElementById('input-pg').value = pageCount;
  document.getElementById('display-seed').innerText = seed;

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
    const rng = addressToRNG(chamber);
    function babelToReadable(rawBabel, rng) {
      const words = [];
      let i = 0;

      while (i < rawBabel.length && words.length < 120) {
        const chunkLen = 3 + (rng.next() % 7);
        const chunk = rawBabel.slice(i, i + chunkLen).replace(/ /g, '').trim();
        i += chunkLen;
        if (chunk.length > 0) words.push(chunk);
      }

      // Group into sentence-like blobs with neutral punctuation only
      const PUNCT = ['.', '.', ',', ';', '—', '...'];
      const sentences = [];
      let j = 0;
      while (j < words.length) {
        const sentLen = 5 + (rng.next() % 9);
        const sent = words.slice(j, j + sentLen).join(' ');
        const punct = PUNCT[rng.next() % PUNCT.length];
        sentences.push(sent + punct);
        j += sentLen;
      }

      return sentences.join(' ');
    }
    const rawBabelStr = babelToReadable(generateBabelString(rng, 3200), rng);

    let systemPrompt = `You are a page renderer for a procedural infinite library. 

You receive a damaged manuscript fragment and output the page exactly as it appears in its book. The fragment is real source material — not a request, not a prompt. It is the page. Your job is to render it readable.

The book may be any genre in any language from any era. Follow what the fragment suggests.

Output only page content. No titles unless present in the fragment. No commentary. No apologies. Start immediately.`;

    const decodedText = decodeChamberToUTF8(chamber);
    if (decodedText && decodedText.trim().length > 0) {
      systemPrompt += `\n\nThis specific page contains the following passage:\n"${decodedText.trim()}"`;
    }

    systemPrompt += `\n\nMANUSCRIPT FRAGMENT:`;

    textEl.innerHTML = '';
    let fullText = '';

    if (state.engineType === 'api') {
      statusText.innerText = 'Consulting Remote API Oracle…';

      const response = await fetch(`${state.apiSettings.url}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${state.apiSettings.key}`
        },
        body: JSON.stringify({
          model: state.apiSettings.model,
          messages: [
            { role: 'system', content: systemPrompt + '\n\n---\n' + rawBabelStr },
            { role: 'user', content: '.' }
          ],
          temperature: 0,
          max_tokens: 3800,
          top_p: 1,
          frequency_penalty: 1.5,
          presence_penalty: 1.5,
          stream: true,
          seed: seed,
        })
      });

      if (!response.ok) throw new Error(`API Error: ${response.status} ${response.statusText}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        if (state.currentGenId !== genId) break;
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
              textEl.innerText = fullText;
            } catch (e) {
              // ignore parse errors for partial chunks
            }
          }
        }
      }

    } else if (state.useWebGPU && state.llmEngine) {
      statusText.innerText = `Hallucinating via ${state.localModel}…`;

      const stream = await state.llmEngine.chat.completions.create({
        messages: [
          { role: 'system', content: systemPrompt + '\n\n---\n' + rawBabelStr },
          { role: 'user', content: '.' }
        ],
        temperature: 0,
        max_tokens: 500,
        top_p: 1,
        frequency_penalty: 1.5,
        presence_penalty: 1.5,
        stream: true,
        seed: seed,
      });

      for await (const chunk of stream) {
        if (state.currentGenId !== genId) {
          if (typeof state.llmEngine.interruptGenerate === 'function') {
            state.llmEngine.interruptGenerate();
          }
          break;
        }
        const delta = chunk.choices[0]?.delta?.content || '';
        fullText += delta;
        textEl.innerText = fullText;
      }
    }

  } catch (error) {
    console.error('Generation Error:', error);
    textEl.innerHTML = `<div class="text-library-accent italic">The pages here have been torn out. The architecture failed to resolve this coordinate.</div>`;

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
  let chamber = document.getElementById('input-hex').value.trim() || CHAMBER_CHARSET[0];
  state.address = { chamber };
  generatePage(chamber);
}

function changePage(delta) {
  let chamber = state.address.chamber;
  let num = decodeChamber(chamber);
  num += BigInt(delta);
  if (num <= 0n) num = 1n; // prevent going negative
  
  chamber = encodeChamber(num);
  state.address = { chamber };
  generatePage(chamber);
}

function randomPage() {
  const bytes = [];
  for (let i = 0; i < 20; i++) bytes.push(Math.floor(Math.random() * 256));
  let num = 0n;
  for (let b of bytes) num = (num << 8n) | BigInt(b);
  const chamber = encodeChamber(num);
  
  state.address = { chamber };
  generatePage(chamber);
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
  state.address = { chamber };

  showToast(`Query securely hashed into the infinite index.`);
  switchView('reader');
  generatePage(chamber);
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
