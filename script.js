const rxCanvas = document.getElementById('rxCanvas');
const rxCtx = rxCanvas.getContext('2d', {willReadFrequently: true});
const txCanvas = document.getElementById('txCanvas');
const txCtx = txCanvas.getContext('2d', {willReadFrequently: true});
const video = document.getElementById('sourceVideo');

const strengthSlider = document.getElementById('strengthSlider');
const colorSyncSlider = document.getElementById('colorSyncSlider');
const flipBtn = document.getElementById('flipBtn');
const recordBtn = document.getElementById('recordBtn');

const WIDTH = 320;
const HEIGHT = 240;

rxCanvas.width = WIDTH;
rxCanvas.height = HEIGHT;
txCanvas.width = WIDTH;
txCanvas.height = HEIGHT;

// Transmission Constants
const H_SYNC_LEN = 20;
const H_BACK_PORCH = 15;
const H_FRONT_PORCH = 5;
const V_SYNC_LINES = 12;

const LEVEL_SYNC = 0.0;
const LEVEL_BLANK = 0.25;
const LEVEL_WHITE = 1.0;

// State
let strength = 1.0;
let colorPhase = 0;
let currentFacingMode = 'user';
let mediaRecorder;
let recordedChunks = [];
let isRecording = false;

// Initialize Camera
async function initCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: currentFacingMode, width: 640, height: 480 },
            audio: false
        });
        video.srcObject = stream;
        video.play();
    } catch (err) {
        console.error("Error accessing camera:", err);
        alert("Could not access camera. Please ensure you've granted permission.");
    }
}

// UI Listeners
strengthSlider.addEventListener('input', (e) => {
    strength = e.target.value / 100;
});

colorSyncSlider.addEventListener('input', (e) => {
    colorPhase = parseInt(e.target.value);
});

flipBtn.addEventListener('click', () => {
    currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
    initCamera();
});

recordBtn.addEventListener('click', () => {
    if (isRecording) {
        stopRecording();
    } else {
        startRecording();
    }
});

// Signal Processing
function encodeFrame(quality) {
    // Draw source to txCanvas
    txCtx.drawImage(video, 0, 0, WIDTH, HEIGHT);
    const pixels = txCtx.getImageData(0, 0, WIDTH, HEIGHT).data;

    const txLineLen = H_SYNC_LEN + H_BACK_PORCH + WIDTH + H_FRONT_PORCH;
    const vsyncSamples = Math.floor(txLineLen * V_SYNC_LINES);
    const totalSamples = vsyncSamples + Math.floor(HEIGHT * txLineLen * 3); // 3 components (RGB)
    
    const signal = new Float32Array(totalSamples);
    let s = 0;

    // 1. V-SYNC
    for (let i = 0; i < vsyncSamples; i++) signal[s++] = LEVEL_SYNC;

    // 2. ACTIVE VIDEO (Sequential RGB)
    for (let y = 0; y < HEIGHT; y++) {
        for (let c = 0; c < 3; c++) {
            // H-SYNC
            for (let i = 0; i < H_SYNC_LEN; i++) signal[s++] = LEVEL_SYNC;
            // Back Porch
            for (let i = 0; i < H_BACK_PORCH; i++) signal[s++] = LEVEL_BLANK;
            // Scanline data
            for (let x = 0; x < WIDTH; x++) {
                const pIdx = (y * WIDTH + x) * 4;
                
                // Physics: Color subcarrier is lost before luminance.
                // We simulate this by blending towards grayscale as quality drops.
                const luma = (pixels[pIdx] * 0.299 + pixels[pIdx + 1] * 0.587 + pixels[pIdx + 2] * 0.114);
                const saturation = Math.max(0, (quality - 0.25) / 0.75);
                
                const originalVal = pixels[pIdx + c];
                const finalVal = (luma * (1 - saturation) + originalVal * saturation) / 255;
                
                signal[s++] = LEVEL_BLANK + finalVal * (LEVEL_WHITE - LEVEL_BLANK);
            }
            // Front Porch
            for (let i = 0; i < H_FRONT_PORCH; i++) signal[s++] = LEVEL_BLANK;
        }
    }
    return signal;
}

function decodeSignal(received) {
    const rxFrame = rxCtx.createImageData(WIDTH, HEIGHT);
    const rxPixels = rxFrame.data;
    
    const SYNC_THRESHOLD = 0.18; 
    const RX_LINE_LEN = H_SYNC_LEN + H_BACK_PORCH + WIDTH + H_FRONT_PORCH;
    
    let ptr = 0;
    
    // Physically grounded AGC: Gain increases as strength drops.
    const agcGain = 1.0 / Math.max(0.01, strength);

    // 1. SEEK V-SYNC
    while (ptr < received.length - 100) {
        let sum = 0;
        for(let i=0; i<60; i++) sum += received[ptr + i];
        const vSyncLimit = (SYNC_THRESHOLD / agcGain) + (Math.random() - 0.5) * 0.05 * (1.0 - strength);
        if ((sum / 60) < vSyncLimit) {
            while(ptr < received.length && received[ptr] < (SYNC_THRESHOLD + 0.1) / agcGain) ptr++;
            break;
        }
        ptr++;
    }

    // 2. DECODE LINES
    for (let y = 0; y < HEIGHT; y++) {
        for (let c = 0; c < 3; c++) {
            const searchLimit = ptr + RX_LINE_LEN * 1.2;
            const hSyncLimit = (SYNC_THRESHOLD / agcGain) + (Math.random() - 0.5) * 0.1 * (1.0 - strength);

            while (ptr < searchLimit && ptr < received.length) {
                if (received[ptr] < hSyncLimit) {
                    ptr += H_SYNC_LEN;
                    break;
                }
                ptr++;
            }

            ptr += H_BACK_PORCH;

            for (let x = 0; x < WIDTH; x++) {
                const val = (ptr < received.length) ? received[ptr++] : (Math.random() - 0.5) * 0.2;
                
                let b = ((val * agcGain) - LEVEL_BLANK) / (LEVEL_WHITE - LEVEL_BLANK);
                b = Math.max(0, Math.min(255, b * 255));
                
                const pIdx = (y * WIDTH + x) * 4;
                const channel = (c + colorPhase) % 3;
                rxPixels[pIdx + channel] = b;
                rxPixels[pIdx + 3] = 255;
            }
            ptr += H_FRONT_PORCH;
        }
    }
    rxCtx.putImageData(rxFrame, 0, 0);
}

function loop() {
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
        // 1. Natural Fluctuation (Fading)
        let effectiveStrength = strength;
        if (strength < 1.0) {
            const time = Date.now() * 0.001;
            const fluctuation = (Math.sin(time * 0.5) * 0.04 + Math.sin(time * 2.1) * 0.02) * (1.0 - strength);
            effectiveStrength = Math.max(0, Math.min(0.999, strength + fluctuation));
        }
        
        const isPerfect = effectiveStrength >= 1.0;
        const quality = isPerfect ? 1.0 : effectiveStrength;

        // Pass quality to encodeFrame for desaturation
        const rawSignal = encodeFrame(quality);
        const noisySignal = new Float32Array(rawSignal.length);
        
        const noiseFloor = 0.18; 
        const txLineLen = H_SYNC_LEN + H_BACK_PORCH + WIDTH + H_FRONT_PORCH;
        const vsyncSamples = Math.floor(txLineLen * V_SYNC_LINES);
        const spatialLineLen = txLineLen * 3;
        
        const lineNoiseSnow = new Float32Array(txLineLen);
        const lineNoiseInterference = new Float32Array(txLineLen);
        let currentInterference = 0;

        for (let i = 0; i < rawSignal.length; i++) {
            if (isPerfect) {
                noisySignal[i] = rawSignal[i];
                continue;
            }

            const offsetFromVSync = i - vsyncSamples;
            if (offsetFromVSync >= 0) {
                const posInSpatialLine = offsetFromVSync % spatialLineLen;
                const posInColorPass = posInSpatialLine % txLineLen;

                if (posInSpatialLine === 0) {
                    for(let j=0; j<txLineLen; j++) {
                        lineNoiseSnow[j] = (Math.random() - 0.5) * noiseFloor;
                        
                        if (Math.random() > 0.9998) {
                            currentInterference = (Math.random() - 0.5) * 1.5;
                        }
                        currentInterference *= 0.97;
                        lineNoiseInterference[j] = currentInterference * (1.0 - quality);
                    }
                }

                const snow = lineNoiseSnow[posInColorPass];
                const ghost = (i > 12) ? rawSignal[i - 12] * 0.4 * (1.0 - quality) * quality : 0;
                const lineInterference = lineNoiseInterference[posInColorPass];
                const spark = (Math.random() > 0.998 + quality * 0.001) ? (Math.random() - 0.5) * 1.0 * (1.0 - quality) : 0;

                // Physics: Signal is attenuated, noise remains constant.
                noisySignal[i] = (rawSignal[i] * quality) + snow + ghost + lineInterference + spark;
            } else {
                // VSync area
                noisySignal[i] = (rawSignal[i] * quality) + (Math.random() - 0.5) * noiseFloor * 0.2;
            }
        }

        decodeSignal(noisySignal);
    }
    requestAnimationFrame(loop);
}

// Recording Logic
function startRecording() {
    recordedChunks = [];
    const stream = rxCanvas.captureStream(30);
    
    const types = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
        'video/mp4'
    ];
    
    let selectedType = '';
    for (const type of types) {
        if (MediaRecorder.isTypeSupported(type)) {
            selectedType = type;
            break;
        }
    }

    mediaRecorder = new MediaRecorder(stream, {
        mimeType: selectedType
    });

    mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
        const blob = new Blob(recordedChunks, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `analog-capture-${Date.now()}.webm`;
        a.click();
        URL.revokeObjectURL(url);
    };

    mediaRecorder.start();
    isRecording = true;
    recordBtn.textContent = 'STOP RECORDING';
    recordBtn.classList.add('recording');
}

function stopRecording() {
    mediaRecorder.stop();
    isRecording = false;
    recordBtn.textContent = 'START RECORDING';
    recordBtn.classList.remove('recording');
}

// Start
initCamera();
requestAnimationFrame(loop);
