const audioEngine = {
  isPlaying: false,
  isInitialized: false,
  lyreLoop: null,
  fluteLoop: null,
  choirSampler: null,
  ancientReverb: null,
  baseUrl: "https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/",

  init: async function () {
    if (this.isInitialized) return;

    // Massive, unending reverb for a stone cathedral/library feel
    this.ancientReverb = new Tone.Reverb({
      decay: 18,
      preDelay: 0.15,
      wet: 0.85
    }).toDestination();

    const dustFilter = new Tone.Filter(600, "lowpass").connect(this.ancientReverb);

    // The Monastic Choir
    this.choirSampler = new Tone.Sampler({
      urls: { "C3": "C3.mp3", "C4": "C4.mp3", "C5": "C5.mp3" },
      baseUrl: this.baseUrl + "choir_aahs-mp3/",
      attack: 3, release: 4, volume: -10
    }).connect(dustFilter);

    // The Ancient Lyre
    const lyreSampler = new Tone.Sampler({
      urls: { "C3": "C3.mp3", "C4": "C4.mp3", "C5": "C5.mp3" },
      baseUrl: this.baseUrl + "acoustic_guitar_nylon-mp3/",
      volume: -4
    }).connect(this.ancientReverb);

    // The Bone Flute
    const fluteSampler = new Tone.Sampler({
      urls: { "C4": "C4.mp3", "C5": "C5.mp3", "C6": "C6.mp3" },
      baseUrl: this.baseUrl + "flute-mp3/",
      attack: 2, release: 3, volume: -6
    }).connect(this.ancientReverb);

    const lyreNotes = ["D3", "F3", "G3", "A3", "C4", "D4", "E4", "F4", "A4"];
    const fluteNotes = ["D4", "E4", "F4", "G4", "A4", "D5"];
    this.droneNotes = ["D2", "A1", "F2", "C2"];

    this.lyreLoop = new Tone.Loop((time) => {
      if (Math.random() > 0.75) {
        const randomNote = lyreNotes[Math.floor(Math.random() * lyreNotes.length)];
        const velocity = 0.4 + Math.random() * 0.4;
        lyreSampler.triggerAttackRelease(randomNote, "2n", time, velocity);
      }
    }, "4n");

    this.fluteLoop = new Tone.Loop((time) => {
      if (Math.random() > 0.85) {
        const randomNote = fluteNotes[Math.floor(Math.random() * fluteNotes.length)];
        fluteSampler.triggerAttackRelease(randomNote, "1m", time);
      }
    }, "2m");

    await Tone.start();
    await Tone.loaded();
    await this.ancientReverb.generate();
    Tone.Transport.bpm.value = 50;

    this.isInitialized = true;
  },

  shiftDrone: function () {
    if (!this.isPlaying) return;
    const targetNote = this.droneNotes[Math.floor(Math.random() * this.droneNotes.length)];
    const duration = 15 + Math.random() * 10;
    this.choirSampler.triggerAttackRelease(targetNote, duration);
    Tone.Transport.scheduleOnce(() => this.shiftDrone(), `+${duration - 3}`);
  },

  toggle: async function () {
    const btnIcon = document.getElementById("audio-toggle-icon");
    const btnText = document.getElementById("audio-toggle-text");

    if (this.isPlaying) {
      // STOP
      this.isPlaying = false;
      Tone.Transport.stop();
      if (this.lyreLoop) this.lyreLoop.stop();
      if (this.fluteLoop) this.fluteLoop.stop();
      if (this.choirSampler) this.choirSampler.releaseAll();
      Tone.Transport.cancel();

      localStorage.setItem("libraryAudioMuted", "true");
      
      if (btnIcon) {
        btnIcon.setAttribute("data-lucide", "volume-x");
        lucide.createIcons();
      }
      if (btnText) btnText.innerText = "Audio Muted";
      
    } else {
      // START
      if (btnText) btnText.innerText = "Loading Audio...";
      try {
        await this.init();
        this.isPlaying = true;
        Tone.Transport.start();
        this.lyreLoop.start(0);
        this.fluteLoop.start(0);
        this.shiftDrone();

        localStorage.setItem("libraryAudioMuted", "false");
        
        if (btnIcon) {
          btnIcon.setAttribute("data-lucide", "volume-2");
          lucide.createIcons();
        }
        if (btnText) btnText.innerText = "Audio Playing";
      } catch (err) {
        console.error("Audio failed to start", err);
        if (btnText) btnText.innerText = "Audio Failed";
      }
    }
  }
};

window.toggleAudio = () => audioEngine.toggle();

document.addEventListener("DOMContentLoaded", () => {
  const isMuted = localStorage.getItem("libraryAudioMuted") === "true";
  const btnIcon = document.getElementById("audio-toggle-icon");
  const btnText = document.getElementById("audio-toggle-text");
  
  if (isMuted) {
    if (btnIcon) btnIcon.setAttribute("data-lucide", "volume-x");
    if (btnText) btnText.innerText = "Audio Muted";
  } else {
    // If not muted, try to autoplay. Note that browsers usually block autoplay until user interaction,
    // but we can bind it to the first click on the document.
    if (btnIcon) btnIcon.setAttribute("data-lucide", "volume-x");
    if (btnText) btnText.innerText = "Click anywhere to Play";
    
    const startAudioOnInteract = () => {
      if (!audioEngine.isPlaying && localStorage.getItem("libraryAudioMuted") === "false") {
        audioEngine.toggle();
      }
      document.removeEventListener("click", startAudioOnInteract);
    };
    document.addEventListener("click", startAudioOnInteract);
  }
});
