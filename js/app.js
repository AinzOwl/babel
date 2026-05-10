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
  address: { hex: '0', wall: 1, shelf: 1, vol: 1, pg: 1 },
  isGenerating: false,
  currentGenId: null,
};

const CONSENT_KEY = 'babel_model_consent';

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

  // Auto-load the reader on first visit
  if (viewName === 'reader') {
    const contentText = document.getElementById('page-content').innerText;
    if (contentText.includes('Enter an address above')) {
      generatePage(state.address.hex, state.address.wall, state.address.shelf, state.address.vol, state.address.pg);
    }
  }
}

// ───────────────────────────────────────────────────────────
// HASHING & SEEDS
// ───────────────────────────────────────────────────────────
function addressToSeed(hex, wall, shelf, vol, pg) {
  let h = 5381;
  for (let i = 0; i < hex.length; i++) {
    h = ((h << 5) + h) ^ hex.charCodeAt(i);
    h = h >>> 0;
  }
  const a = BigInt(h) * 1000000007n;
  const b = BigInt(wall) * 998244353n;
  const c = BigInt(shelf) * 999999937n;
  const d = BigInt(vol) * 1000000009n;
  const e = BigInt(pg) * 999999929n;
  const mixed = (a ^ (b << 13n) ^ (c << 7n) ^ (d >> 3n) ^ (e >> 5n)) & 0xFFFFFFFFn;
  return Number(mixed);
}

function searchToAddress(query) {
  let h = 5381;
  for (let i = 0; i < query.length; i++) {
    h = ((h << 5) + h) ^ query.charCodeAt(i);
    h = h >>> 0;
  }
  let h2 = h;
  for (let i = 0; i < query.length; i++) {
    h2 = ((h2 << 3) + h2) ^ query.charCodeAt(i);
    h2 = h2 >>> 0;
  }
  const hex = (h.toString(36) + h2.toString(36) + (h ^ h2).toString(36)).substring(0, 10);
  const wall = (h2 % 4) + 1;
  const shelf = ((h ^ h2) % 5) + 1;
  const vol = (h2 % 32) + 1;
  const pg = ((h ^ h2) % 410) + 1;
  return { hex, wall, shelf, vol, pg };
}


// ───────────────────────────────────────────────────────────
// TOPIC HINTS FOR LLM PROMPT
// ───────────────────────────────────────────────────────────

function seedToTopicHint(seed) {
  const topics = [
    "the nature of forgotten languages", "the geography of dreams", "the mathematics of grief",
    "ancient methods of preserving memory", "the philosophy of empty spaces", "the taxonomy of silences",
    "the history of colors that no longer exist", "theories of time perceived in sleep",
    "the cartography of imaginary seas", "the biography of light through leaves",
    "the archaeology of disappeared cities", "the ecology of mythical creatures",
    "the ethics of memory and forgetting", "the astronomy of invisible stars",
    "the botany of plants that only grow in darkness", "recipes known only to extinct civilizations",
    "the music of unheard instruments", "the law and customs of impossible nations",
    "the natural history of paradoxes", "the study of reflections that outlive their sources",
    "theories on why certain moments feel eternal", "the migration patterns of ideas across centuries",
    "the anatomy of words that have no translation", "the economics of traded shadows",
    "the meteorology of emotional climates", "the theology of minor deities",
    "methods of counting things that cannot be counted", "the diplomacy between dreams and wakefulness",
    "the engineering of structures built entirely from sound", "the physics of coincidence",
  ];
  return topics[seed % topics.length];
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

    state.llmEngine = await CreateMLCEngine('SmolLM2-135M-Instruct-q0f16-MLC', {
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

    document.getElementById('oracle-active-state').classList.remove('hidden');
    document.getElementById('oracle-active-state').classList.add('flex');

    statusDot.classList.replace('bg-yellow-500', 'bg-green-500');
    statusDot.classList.remove('animate-pulse');

    showToast('Oracle Awake. Intelligence is now active.');

    // Regenerate current page if reader is open
    if (state.view === 'reader' && !state.isGenerating) {
      generatePage(state.address.v, state.address.c, state.address.p);
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
async function generatePage(hex, wall, shelf, vol, pg) {
  // Oracle not ready — show the asleep state and prompt the user
  if (!state.modelLoaded || !state.useWebGPU) {
    _showOracleAsleep();
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

  const seed = addressToSeed(hex, wall, shelf, vol, pg);

  document.getElementById('input-hex').value = hex;
  document.getElementById('input-wall').value = wall;
  document.getElementById('input-shelf').value = shelf;
  document.getElementById('input-vol').value = vol;
  document.getElementById('input-pg').value = pg;
  document.getElementById('display-seed').innerText = seed;

  const textEl = document.getElementById('page-content');
  const genIndicator = document.getElementById('gen-indicator');
  const statusText = document.getElementById('gen-status-text');
  const timeEl = document.getElementById('gen-time');

  textEl.innerHTML = `<div class="w-full h-64 page-text-loading"></div>`;
  timeEl.innerText = '';
  genIndicator.classList.remove('hidden');
  genIndicator.classList.add('flex');

  const t0 = Date.now();

  try {
    if (state.useWebGPU && state.llmEngine) {
      statusText.innerText = 'Hallucinating via WebGPU…';

      const topicHint = seedToTopicHint(seed);
      const prompt = `Write a single page from an old library book. The page is located in Hexagon ${hex}, Wall ${wall}, Shelf ${shelf}, Volume ${vol}, Page ${pg}. Write about: ${topicHint}. Write 3-5 paragraphs of literary prose, as if from an ancient encyclopedia, philosophical text, or literary work. Be specific and evocative. Do not include headings, titles, or pleasantries. Start writing the prose immediately.`;

      textEl.innerHTML = '';

      let fullText = '';
      const stream = await state.llmEngine.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.001,
        max_tokens: 400,
        stream: true,
        seed: seed % 2147483647,
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

    } // end if useWebGPU

  } catch (error) {
    console.error('Generation Error:', error);
    textEl.innerHTML = `<div class="text-library-accent italic">The pages here have been torn out. The architecture failed to resolve this coordinate.</div>`;

  } finally {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
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
  let hex = document.getElementById('input-hex').value.trim() || '0';
  let wall = parseInt(document.getElementById('input-wall').value) || 1;
  let shelf = parseInt(document.getElementById('input-shelf').value) || 1;
  let vol = parseInt(document.getElementById('input-vol').value) || 1;
  let pg = parseInt(document.getElementById('input-pg').value) || 1;

  wall = Math.max(1, Math.min(wall, 4));
  shelf = Math.max(1, Math.min(shelf, 5));
  vol = Math.max(1, Math.min(vol, 32));
  pg = Math.max(1, Math.min(pg, 410));

  state.address = { hex, wall, shelf, vol, pg };
  generatePage(hex, wall, shelf, vol, pg);
}

function changePage(delta) {
  let { hex, wall, shelf, vol, pg } = state.address;
  pg += delta;

  if (pg < 1) {
    if (vol > 1) { vol--; pg = 410; }
    else if (shelf > 1) { shelf--; vol = 32; pg = 410; }
    else if (wall > 1) { wall--; shelf = 5; vol = 32; pg = 410; }
    else { pg = 1; }
  }
  if (pg > 410) {
    pg = 1; vol++;
    if (vol > 32) { vol = 1; shelf++; }
    if (shelf > 5) { shelf = 1; wall++; }
    if (wall > 4) { wall = 4; shelf = 5; vol = 32; pg = 410; }
  }

  state.address = { hex, wall, shelf, vol, pg };
  generatePage(hex, wall, shelf, vol, pg);
}

function randomPage() {
  const hex = Math.random().toString(36).substring(2, 12);
  const wall = Math.floor(Math.random() * 4) + 1;
  const shelf = Math.floor(Math.random() * 5) + 1;
  const vol = Math.floor(Math.random() * 32) + 1;
  const pg = Math.floor(Math.random() * 410) + 1;
  state.address = { hex, wall, shelf, vol, pg };
  generatePage(hex, wall, shelf, vol, pg);
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

  const { hex, wall, shelf, vol, pg } = searchToAddress(query);
  state.address = { hex, wall, shelf, vol, pg };

  showToast(`Query hashed to Hex ${hex}, Wall ${wall}, Shelf ${shelf}, Vol ${vol}, Pg ${pg}`);
  switchView('reader');
  generatePage(hex, wall, shelf, vol, pg);
}

// ───────────────────────────────────────────────────────────
// UTILITIES
// ───────────────────────────────────────────────────────────
function copyAddress() {
  const seed = document.getElementById('display-seed').innerText;
  const addr = `The Library of Babel [LLM Edition]\nHex ${state.address.hex}, Wall ${state.address.wall}, Shelf ${state.address.shelf}, Vol ${state.address.vol}, Pg ${state.address.pg} | Seed: ${seed}`;

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
  const consent = localStorage.getItem(CONSENT_KEY);

  if (consent === 'accepted') {
    // Auto-init: loads from cache instantly on return visits
    setTimeout(initModel, 400);
  } else if (!consent) {
    // First visit — show consent modal after brief paint delay
    setTimeout(showConsentModal, 300);
  }
  // 'declined' → oracle stays asleep, user can browse freely
}

// ───────────────────────────────────────────────────────────
// BOOT
// ───────────────────────────────────────────────────────────
checkConsent();
