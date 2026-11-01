// SPDX-License-Identifier: MIT
// The analyser and visual style are derived from Spotifast:
// https://github.com/crmne/spotifast (c) 2026 Carmine Paolino, MIT.

import Cairo from 'gi://cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gst from 'gi://Gst';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const UUID = 'audioviz@deanp';
const STYLE_OFF = 'off';
const STYLE_BARS = 'bars';
const STYLE_WAVE = 'wave';
const STYLES = [STYLE_OFF, STYLE_BARS, STYLE_WAVE];

// Spotifast's player-bar visualizer, from crmne/spotifast v0.14.2:
// src/vis.rs (WideAnalyser, Fft, bands) and src/ui/player_bar.rs (spectrum).
const SAMPLE_RATE = 44100;
const FFT_SAMPLES = 512;
const SPECTRUM_BINS = 256;
const COLUMNS = 75;
const MAX_HEIGHT = 15.0;
const WIDE_FALL = 3.0;
const PEAK_HOLD = 0.35;
const PEAK_GRAVITY = 2.4;
const CHANNEL_SUM = 2.0;
const SPEC_SCALE = 0.5;

const SPECTRUM_GAP = 2.0;
const PEAK_HEIGHT = 2.0;
const PEAK_GAP = 2.0;
const SPECTRUM_FOOT_ALPHA = 0.28;
const SPECTRUM_TOP_ALPHA = 0.08;
const GLOW_ALPHA = 0.12;
const PEAK_ALPHA = 0.7;
const PULSE_ALPHA = 0.35;

const WAVE_FILL_ALPHA = 0.14;
const WAVE_ECHO_ALPHA = 0.18;
const WAVE_LAYERS = [[9.0, 0.06], [4.0, 0.16], [1.6, 0.85]];

const STEP_INTERVAL_MS = 16;
const STEP_SECONDS = 1 / 60;

const RING_SIZE = 16384;
const PIPELINE_DESC =
    `pulsesrc device=@DEFAULT_MONITOR@ ! audioconvert ! audioresample ! ` +
    `audio/x-raw,format=F32LE,channels=1,rate=${SAMPLE_RATE} ! ` +
    `appsink name=audiovizsink emit-signals=false max-buffers=8 drop=true sync=false`;

const STYLE_LABELS = {
    [STYLE_OFF]: 'Off',
    [STYLE_BARS]: 'Bars',
    [STYLE_WAVE]: 'Waveform',
};

// GNOME's accent colours, as libadwaita defines them.
const ACCENT_COLOURS = {
    blue: [0x35, 0x84, 0xe4],
    teal: [0x21, 0x90, 0xa4],
    green: [0x3a, 0x94, 0x4a],
    yellow: [0xc8, 0x88, 0x00],
    orange: [0xed, 0x5b, 0x00],
    red: [0xe6, 0x2d, 0x42],
    pink: [0xd5, 0x61, 0x99],
    purple: [0x91, 0x41, 0xac],
    slate: [0x6f, 0x83, 0x96],
};

const DARK_CEILING = 0.35;

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

// ---------------------------------------------------------------- Winamp FFT

const bitReversal = new Int32Array(FFT_SAMPLES);
{
    const bits = 9; // log2(512)
    for (let i = 0; i < FFT_SAMPLES; i++) {
        let reversed = 0;
        for (let bit = 0; bit < bits; bit++)
            reversed |= ((i >> bit) & 1) << (bits - 1 - bit);
        bitReversal[i] = reversed;
    }
}

const envelope = new Float32Array(FFT_SAMPLES);
for (let i = 0; i < FFT_SAMPLES; i++) {
    const phase = i / FFT_SAMPLES * Math.PI * 2;
    envelope[i] = 0.5 + 0.5 * Math.sin(phase - Math.PI / 2);
}

const twiddles = [];
for (let size = 2; size <= FFT_SAMPLES; size <<= 1) {
    const theta = -Math.PI * 2 / size;
    twiddles.push([Math.cos(theta), Math.sin(theta)]);
}

const fftReal = new Float32Array(FFT_SAMPLES);
const fftImaginary = new Float32Array(FFT_SAMPLES);
const fftSpectrum = new Float32Array(SPECTRUM_BINS);

function computeSpectrum(samples) {
    for (let i = 0; i < FFT_SAMPLES; i++) {
        const from = bitReversal[i];
        fftReal[i] = samples[from] * envelope[from];
        fftImaginary[i] = 0;
    }

    let size = 2;
    let stage = 0;
    while (size <= FFT_SAMPLES) {
        const [wpr, wpi] = twiddles[stage];
        let wr = 1;
        let wi = 0;
        const half = size >> 1;
        for (let m = 0; m < half; m++) {
            for (let i = m; i < FFT_SAMPLES; i += size) {
                const j = i + half;
                const tr = wr * fftReal[j] - wi * fftImaginary[j];
                const ti = wr * fftImaginary[j] + wi * fftReal[j];
                fftReal[j] = fftReal[i] - tr;
                fftImaginary[j] = fftImaginary[i] - ti;
                fftReal[i] += tr;
                fftImaginary[i] += ti;
            }
            const previous = wr;
            wr = wr * wpr - wi * wpi;
            wi = wi * wpr + previous * wpi;
        }
        size <<= 1;
        stage++;
    }

    for (let i = 0; i < SPECTRUM_BINS; i++) {
        fftSpectrum[i] =
            Math.hypot(fftReal[i], fftImaginary[i]) * SPEC_SCALE;
    }
}

// Winamp's bands over a 256-bin spectrum: 75 semitone-spaced columns, each
// summing its share of the bins, fractional edges read through a Hermite
// curve, the sum clipped at 255. Ported from Spotifast's bands().
const bandScale = 255.0 / Math.pow(2, 75.0 / 12.0);
const bandValues = new Float32Array(COLUMNS);

function warp(x) {
    return (Math.pow(2, x / 12.0) - 1.0) * bandScale;
}

function hermite(x, y0, y1, y2, y3) {
    const c1 = 0.5 * (y2 - y0);
    const c3 = 1.5 * (y1 - y2) + 0.5 * (y3 - y0);
    const c2 = y0 - y1 + c1 - c3;
    return ((c3 * x + c2) * x + c1) * x + y1;
}

function computeBands() {
    let next = warp(0.0) + 1.0;
    for (let x = 0; x < COLUMNS; x++) {
        const low = next;
        next = warp(x + 1.0) + 1.0;

        let value = 0.0;
        let bin = Math.floor(low);
        const end = Math.min(Math.floor(next), SPECTRUM_BINS - 1);
        let fraction = low;
        let mult = (bin + 1.0) - low;
        let useHermite = true;

        for (;;) {
            if (bin === end) {
                mult = next - fraction;
                useHermite = true;
            }
            if (useHermite) {
                value += hermite(
                    fraction - bin,
                    bin > 0 ? fftSpectrum[bin - 1] : 0.0,
                    fftSpectrum[bin] ?? 0.0,
                    fftSpectrum[bin + 1] ?? 0.0,
                    fftSpectrum[bin + 2] ?? 0.0) * mult;
            } else {
                value += fftSpectrum[bin] ?? 0.0;
            }
            useHermite = false;
            bin += 1;
            if (bin > end)
                break;
            fraction = bin;
        }

        bandValues[x] = Math.min(value, 255.0);
    }
}

// ------------------------------------------------------- Spotifast analyser

class WideAnalyser {
    constructor() {
        this.levels = new Float32Array(COLUMNS);
        this.peaks = new Float32Array(COLUMNS);
        this.held = new Float32Array(COLUMNS);
        this.speed = new Float32Array(COLUMNS);
        this._wave = new Float32Array(FFT_SAMPLES);
        this._last = 0;
    }

    reset() {
        this.levels.fill(0);
        this.peaks.fill(0);
        this.held.fill(0);
        this.speed.fill(0);
        this._last = 0;
    }

    step(samples, now) {
        const elapsed = this._last
            ? Math.min(now - this._last, 0.25)
            : STEP_SECONDS;
        this._last = now;

        for (let i = 0; i < FFT_SAMPLES; i++)
            this._wave[i] = (samples[i] ?? 0) * CHANNEL_SUM;
        computeSpectrum(this._wave);
        computeBands();

        for (let band = 0; band < COLUMNS; band++) {
            const target = Math.min(bandValues[band], MAX_HEIGHT) / MAX_HEIGHT;
            let level = Math.max(
                this.levels[band] - WIDE_FALL * elapsed, target);
            if (level < 0.01)
                level = 0;
            this.levels[band] = level;
        }

        for (let band = 0; band < COLUMNS; band++) {
            const level = this.levels[band];
            if (level >= this.peaks[band]) {
                this.peaks[band] = level;
                this.held[band] = 0;
                this.speed[band] = 0;
            } else if (this.held[band] < PEAK_HOLD) {
                this.held[band] += elapsed;
            } else {
                this.speed[band] += PEAK_GRAVITY * elapsed;
                this.peaks[band] = Math.max(
                    this.peaks[band] - this.speed[band] * elapsed, level);
            }
            if (this.peaks[band] < 0.01)
                this.peaks[band] = 0;
        }
    }

    get settled() {
        for (let band = 0; band < COLUMNS; band++) {
            if (this.levels[band] !== 0 || this.peaks[band] !== 0)
                return false;
        }
        return true;
    }
}

// ---------------------------------------------------------------- colour

function srgbToLinear(value) {
    return value <= 0.04045
        ? value / 12.92
        : Math.pow((value + 0.055) / 1.055, 2.4);
}

function linearToSrgb(value) {
    return value <= 0.0031308
        ? value * 12.92
        : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

function rgbToHsv(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;

    let hue = 0;
    if (delta !== 0) {
        if (max === r)
            hue = ((g - b) / delta) % 6;
        else if (max === g)
            hue = (b - r) / delta + 2;
        else
            hue = (r - g) / delta + 4;
        hue /= 6;
        if (hue < 0)
            hue += 1;
    }

    return [hue, max === 0 ? 0 : delta / max, max];
}

function hsvToRgb(h, s, v) {
    const sector = (h - Math.floor(h)) * 6;
    const fraction = sector - Math.floor(sector);
    const p = v * (1 - s);
    const q = v * (1 - s * fraction);
    const t = v * (1 - s * (1 - fraction));

    switch (Math.floor(sector) % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
    }
}

// Spotifast's within_brightness(): keep the hue, scale linear luminance
// into the dark theme's ceiling.
function withinBrightness(colour) {
    const [r, g, b] = colour.map(srgbToLinear);
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (luminance <= DARK_CEILING)
        return colour;

    const factor = DARK_CEILING / luminance;
    return [r, g, b].map(value => linearToSrgb(value * factor));
}

// Spotifast's vis_colours() fallback: the accent for the bass, the same
// turned a sixth of the way round the colour wheel for the treble, each
// made vivid and kept within the dark theme's brightness.
function buildColours(accentName) {
    const rgb = ACCENT_COLOURS[accentName] ?? ACCENT_COLOURS.blue;
    const [hue, saturation] = rgbToHsv(
        rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
    const vivid = Math.max(saturation, 0.55);
    const keep = h => withinBrightness(hsvToRgb(h, vivid, 1.0));
    return [keep(hue), keep((hue + 1 / 6) % 1)];
}

function lerpColour(a, b, t) {
    return [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ];
}

// ----------------------------------------------------------------- extension

export default class AudioVisualizerExtension extends Extension {
    enable() {
        if (!Gst.is_initialized())
            Gst.init(null);

        this._enabled = true;
        this._style = this._loadStyle();
        this._lastNonOffStyle = this._style === STYLE_OFF ? STYLE_BARS : this._style;

        this._panelWidth = 0;
        this._panelHeight = 0;
        this._analyser = new WideAnalyser();
        this._ring = new Float32Array(RING_SIZE);
        this._written = 0;
        this._lastStepWritten = 0;
        this._lastSampleTime = 0;
        this._stepBuffer = new Float32Array(FFT_SAMPLES);
        this._waveSamples = new Float32Array(0);
        this._waveTrace = new Float32Array(0);

        this._pipeline = null;
        this._appsink = null;
        this._bus = null;
        this._busErrorId = 0;
        this._stepTimerId = 0;
        this._restartId = 0;
        this._recovering = false;
        this._sawSpectrum = false;

        this._settings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._accentChangedId = this._settings.connect(
            'changed::accent-color', () => {
                this._updateColours();
                this._queueRepaint();
            });
        this._updateColours();

        this._buildOverlay();
        this._buildQuickSettings();
        this._applyStyle(this._style, false);
    }

    disable() {
        this._enabled = false;

        if (this._panelAllocationId) {
            Main.panel.disconnect(this._panelAllocationId);
            this._panelAllocationId = 0;
        }

        this._stopCapture();

        if (this._area) {
            this._area.destroy();
            this._area = null;
        }

        if (this._accentChangedId) {
            this._settings.disconnect(this._accentChangedId);
            this._accentChangedId = 0;
        }
        this._settings = null;

        if (this._quickToggle) {
            this._quickToggle.menu.destroy();
            this._quickToggle.destroy();
            this._quickToggle = null;
        }
        this._styleItems?.clear();
        this._styleItems = null;
    }

    // ------------------------------------------------------------------ UI

    _buildOverlay() {
        const panel = Main.panel;

        this._area = new St.DrawingArea({
            reactive: false,
            can_focus: false,
        });
        this._area.connect('repaint', () => this._draw());
        this._area.connect('destroy', () => {
            this._area = null;
        });

        // The panel draws its status boxes itself rather than using a layout
        // manager, so insert at index 0 and allocate the overlay ourselves.
        // That keeps it above the panel background and behind every indicator.
        panel.insert_child_at_index(this._area, 0);

        this._panelAllocationId = panel.connect(
            'notify::allocation', () => this._syncGeometry());
        this._syncGeometry();
    }

    _syncGeometry() {
        if (!this._area)
            return;

        const panel = Main.panel;
        const width = panel.width || Main.layoutManager.primaryMonitor?.width || 0;
        const height = panel.height || 0;
        if (width <= 0 || height <= 0)
            return;

        if (width !== this._panelWidth || height !== this._panelHeight) {
            this._panelWidth = width;
            this._panelHeight = height;
        }

        this._area.width = width;
        this._area.height = height;

        const box = new Clutter.ActorBox();
        box.x1 = 0;
        box.y1 = 0;
        box.x2 = width;
        box.y2 = height;
        this._area.allocate(box);

        this._queueRepaint();
    }

    _buildQuickSettings() {
        this._quickToggle = new QuickSettings.QuickMenuToggle({
            title: 'Visualizer',
            subtitle: STYLE_LABELS[this._style],
            iconName: 'audio-x-generic-symbolic',
            toggleMode: true,
            checked: this._style !== STYLE_OFF,
            menuEnabled: true,
        });

        this._quickToggle.menu.setHeader(
            'audio-x-generic-symbolic', 'Audio Visualizer');

        this._styleItems = new Map();
        for (const style of STYLES) {
            const item = new PopupMenu.PopupMenuItem(STYLE_LABELS[style]);
            item.connect('activate', () => this._setStyle(style));
            this._styleItems.set(style, item);
            this._quickToggle.menu.addMenuItem(item);
        }

        this._quickToggle.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const restartItem = new PopupMenu.PopupMenuItem('Restart audio capture');
        restartItem.connect('activate', () => this._restartCapture());
        this._quickToggle.menu.addMenuItem(restartItem);

        this._quickToggle.connect('clicked', () => {
            if (this._style === STYLE_OFF)
                this._setStyle(this._lastNonOffStyle);
            else
                this._setStyle(STYLE_OFF);
        });

        Main.panel.statusArea.quickSettings.menu.addItem(this._quickToggle, 1);
    }

    _setStyle(style) {
        if (!STYLES.includes(style))
            style = STYLE_BARS;

        if (style !== STYLE_OFF)
            this._lastNonOffStyle = style;

        this._applyStyle(style, true);
    }

    _applyStyle(style, persist) {
        this._style = style;
        const on = style !== STYLE_OFF;

        if (this._area) {
            this._area.visible = on;
            this._queueRepaint();
        }

        if (this._quickToggle) {
            this._quickToggle.subtitle = STYLE_LABELS[style];
            this._quickToggle.checked = on;

            for (const [itemStyle, item] of this._styleItems) {
                item.setOrnament(itemStyle === style
                    ? PopupMenu.Ornament.CHECK
                    : PopupMenu.Ornament.NONE);
            }
        }

        if (persist)
            this._saveStyle(style);

        if (on) {
            if (!this._pipeline)
                this._startCapture();
            this._queueRepaint();
        } else {
            this._stopCapture();
        }
    }

    // ------------------------------------------------------------ settings

    _configPath() {
        return GLib.build_filenamev([
            GLib.get_user_config_dir(),
            'gnome-audio-visualizer.json',
        ]);
    }

    _loadStyle() {
        try {
            const [ok, contents] = GLib.file_get_contents(this._configPath());
            if (!ok)
                return STYLE_BARS;
            const data = JSON.parse(new TextDecoder().decode(contents));
            return STYLES.includes(data.style) ? data.style : STYLE_BARS;
        } catch (e) {
            return STYLE_BARS;
        }
    }

    _saveStyle(style) {
        try {
            const data = new TextEncoder().encode(JSON.stringify({style}));
            GLib.file_set_contents(this._configPath(), data);
        } catch (e) {
            console.warn(`[${UUID}] could not save style: ${e.message}`);
        }
    }

    _updateColours() {
        let accent = 'blue';
        try {
            accent = this._settings.get_string('accent-color') || 'blue';
        } catch (e) {
            // Older shells have no accent-color key.
        }
        this._colours = buildColours(accent);
    }

    _sweep(at) {
        const colours = this._colours ?? buildColours('blue');
        return lerpColour(colours[0], colours[1], clamp(at, 0, 1));
    }

    // ------------------------------------------------------------- capture

    _startCapture() {
        if (!this._enabled || this._pipeline || this._style === STYLE_OFF)
            return;

        let pipeline;
        try {
            pipeline = Gst.parse_launch(PIPELINE_DESC);
        } catch (e) {
            console.error(`[${UUID}] could not build capture pipeline: ${e.message}`);
            this._scheduleRestart(5000);
            return;
        }

        this._pipeline = pipeline;
        this._appsink = pipeline.get_by_name('audiovizsink');

        this._bus = pipeline.get_bus();
        this._bus.add_signal_watch();
        this._busErrorId = this._bus.connect(
            'message::error', (bus, message) => this._onPipelineError(message));

        const state = pipeline.set_state(Gst.State.PLAYING);
        if (state === Gst.StateChangeReturn.FAILURE) {
            console.error(`[${UUID}] audio capture failed to start`);
            this._stopCapture();
            this._scheduleRestart(5000);
            return;
        }

        this._startTimers();
    }

    _stopCapture() {
        if (this._restartId) {
            GLib.source_remove(this._restartId);
            this._restartId = 0;
        }

        this._stopTimers();

        if (this._bus) {
            if (this._busErrorId) {
                this._bus.disconnect(this._busErrorId);
                this._busErrorId = 0;
            }
            this._bus.remove_signal_watch();
            this._bus = null;
        }

        this._appsink = null;

        if (this._pipeline) {
            const pipeline = this._pipeline;
            this._pipeline = null;
            pipeline.set_state(Gst.State.NULL);
            // Wait briefly so the pipeline releases the monitor device before
            // the JS reference is dropped.
            pipeline.get_state(Gst.SECOND);
        }

        this._sawSpectrum = false;
        this._written = 0;
        this._lastStepWritten = 0;
        this._lastSampleTime = 0;
        this._ring.fill(0);
        this._analyser.reset();
        this._queueRepaint();
    }

    _restartCapture() {
        if (this._style === STYLE_OFF)
            return;

        this._stopCapture();
        this._startCapture();
    }

    _scheduleRestart(delayMs) {
        if (!this._enabled || this._restartId || this._style === STYLE_OFF)
            return;

        this._restartId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._restartId = 0;
            if (this._style !== STYLE_OFF)
                this._startCapture();
            return GLib.SOURCE_REMOVE;
        });
    }

    _startTimers() {
        this._stopTimers();

        this._stepTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, STEP_INTERVAL_MS, () => {
                this._step();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _stopTimers() {
        if (this._stepTimerId) {
            GLib.source_remove(this._stepTimerId);
            this._stepTimerId = 0;
        }
    }

    _onPipelineError(message) {
        if (this._recovering)
            return;
        this._recovering = true;

        const structure = message.get_structure();
        console.error(`[${UUID}] audio capture error: ${structure?.to_string() ?? 'unknown'}`);

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._recovering = false;
            if (this._enabled && this._style !== STYLE_OFF) {
                this._stopCapture();
                this._scheduleRestart(5000);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _drainSamples() {
        if (!this._appsink)
            return;

        for (;;) {
            const sample = this._appsink.emit('try-pull-sample', 0);
            if (!sample)
                break;

            const buffer = sample.get_buffer();
            const size = buffer.get_size();
            if (size < 4)
                continue;

            const bytes = buffer.extract_dup(0, size);
            let values;
            if (bytes.byteOffset % 4 === 0) {
                values = new Float32Array(
                    bytes.buffer, bytes.byteOffset, size / 4);
            } else {
                const view = new DataView(
                    bytes.buffer, bytes.byteOffset, bytes.byteLength);
                values = new Float32Array(size / 4);
                for (let i = 0; i < values.length; i++)
                    values[i] = view.getFloat32(i * 4, true);
            }

            for (let i = 0; i < values.length; i++) {
                this._ring[this._written % RING_SIZE] = values[i];
                this._written++;
            }
        }
    }

    _readLatest(count, out) {
        const available = Math.min(count, this._written);
        const missing = count - available;

        for (let i = 0; i < missing; i++)
            out[i] = 0;

        for (let i = 0; i < available; i++) {
            const index = this._written - available + i;
            const wrapped = ((index % RING_SIZE) + RING_SIZE) % RING_SIZE;
            out[missing + i] = this._ring[wrapped];
        }
        return out;
    }

    // -------------------------------------------------------------- levels

    _step() {
        if (!this._enabled || this._style === STYLE_OFF)
            return;

        this._drainSamples();

        const now = GLib.get_monotonic_time() / 1e6;
        if (this._written !== this._lastStepWritten) {
            this._lastStepWritten = this._written;
            this._lastSampleTime = now;
        }

        // The monitor stops producing buffers when playback pauses. Treat a
        // stalled tap as silence, so the bars fall instead of freezing.
        if (now - this._lastSampleTime > 0.1)
            this._stepBuffer.fill(0);
        else
            this._readLatest(FFT_SAMPLES, this._stepBuffer);

        this._analyser.step(this._stepBuffer, now);
        this._queueRepaint();

        if (!this._sawSpectrum && this._written > 0) {
            this._sawSpectrum = true;
            console.log(`[${UUID}] receiving audio`);
        }
    }

    // ----------------------------------------------------------- rendering

    _queueRepaint() {
        if (!this._area)
            return;
        try {
            this._area.queue_repaint();
        } catch (e) {
            // The actor can already be disposed while the shell is shutting
            // down, before the extension gets disabled.
            this._area = null;
        }
    }

    _draw() {
        const area = this._area;
        if (!area)
            return;

        const [surfaceWidth, surfaceHeight] = area.get_surface_size();
        if (surfaceWidth <= 0 || surfaceHeight <= 0)
            return;

        const cr = area.get_context();
        try {
            cr.setOperator(Cairo.Operator.CLEAR);
            cr.paint();
            cr.setOperator(Cairo.Operator.OVER);

            if (this._style === STYLE_OFF)
                return;

            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const width = surfaceWidth / scale;
            const height = surfaceHeight / scale;
            cr.scale(scale, scale);

            cr.save();
            cr.rectangle(0, 0, width, height);
            cr.clip();

            if (this._style === STYLE_BARS)
                this._drawBars(cr, width, height);
            else
                this._drawWave(cr, width, height);

            cr.restore();
        } finally {
            cr.$dispose();
        }
    }

    _shaded(cr, x, y, width, height, colour, topAlpha, bottomAlpha) {
        if (width <= 0 || height <= 0)
            return;

        const gradient = new Cairo.LinearGradient(0, y, 0, y + height);
        gradient.addColorStopRGBA(
            0, colour[0], colour[1], colour[2], clamp(topAlpha, 0, 1));
        gradient.addColorStopRGBA(
            1, colour[0], colour[1], colour[2], clamp(bottomAlpha, 0, 1));
        cr.setSource(gradient);
        cr.rectangle(x, y, width, height);
        cr.fill();
    }

    _drawBars(cr, width, height) {
        const bands = COLUMNS;
        const barWidth = (width - SPECTRUM_GAP * (bands - 1)) / bands;
        const reach = height - PEAK_GAP - PEAK_HEIGHT - 1.0;
        if (barWidth <= 0 || reach <= 0)
            return;

        const levels = this._analyser.levels;
        const peaks = this._analyser.peaks;

        // The bass pulse: a glow along the foot, as strong as the low bands.
        let bass = 0;
        const bassBands = Math.max(1, Math.floor(bands / 8));
        for (let band = 0; band < bassBands; band++)
            bass += levels[band];
        bass /= bassBands;

        const bassColour = this._sweep(0);
        this._shaded(cr, 0, height / 2, width, height / 2,
            bassColour, 0, PULSE_ALPHA * bass * bass);

        for (let band = 0; band < bands; band++) {
            const level = levels[band];
            const peak = peaks[band];
            const left = band * (barWidth + SPECTRUM_GAP);
            const colour = this._sweep(band / (bands - 1));
            const barHeight = level * reach;

            if (barHeight >= 1.0) {
                const top = height - barHeight;

                // The glow: the bar again, wider and fainter.
                this._shaded(
                    cr,
                    left - SPECTRUM_GAP,
                    top - 3,
                    barWidth + SPECTRUM_GAP * 2,
                    barHeight + 6,
                    colour,
                    GLOW_ALPHA * 0.3,
                    GLOW_ALPHA);

                const topAlpha = SPECTRUM_FOOT_ALPHA +
                    (SPECTRUM_TOP_ALPHA - SPECTRUM_FOOT_ALPHA) * level;
                this._shaded(
                    cr,
                    left,
                    top,
                    barWidth,
                    barHeight,
                    colour,
                    topAlpha,
                    SPECTRUM_FOOT_ALPHA);
            }

            const capHeight = peak * reach;
            if (capHeight >= 2.0) {
                const y = height - capHeight - PEAK_GAP;
                cr.setSourceRGBA(
                    colour[0], colour[1], colour[2], PEAK_ALPHA);
                cr.rectangle(
                    left, y - PEAK_HEIGHT, barWidth, PEAK_HEIGHT);
                cr.fill();
            }
        }
    }

    _drawWave(cr, width, height) {
        const count = clamp(Math.floor(width / 8), 75, 320);
        const sampleCount = count * 7;

        if (this._waveSamples.length < sampleCount) {
            this._waveSamples = new Float32Array(sampleCount);
            this._waveTrace = new Float32Array(count);
        }

        const samples = this._waveSamples;
        this._readLatest(sampleCount, samples);

        const trace = this._waveTrace;
        for (let i = 0; i < count; i++) {
            const sample = samples[i * 7] ?? 0;
            trace[i] = clamp(sample * 2, -1, 1);
        }

        const reach = height * 0.46;
        const step = width / (count - 1);
        const midline = height / 2;
        const point = (index, value) => [
            index * step,
            midline - value * reach,
        ];

        // The shading between the wave and the midline.
        for (let i = 0; i < count - 1; i++) {
            const colour = this._sweep(i / (count - 1));
            const [x0, y0] = point(i, trace[i]);
            const [x1, y1] = point(i + 1, trace[i + 1]);
            const waveY = (y0 + y1) / 2;
            const gradient = new Cairo.LinearGradient(
                0, waveY, 0, midline);
            gradient.addColorStopRGBA(
                0, colour[0], colour[1], colour[2], WAVE_FILL_ALPHA);
            gradient.addColorStopRGBA(
                1, colour[0], colour[1], colour[2], 0);
            cr.setSource(gradient);
            cr.moveTo(x0, y0);
            cr.lineTo(x1, y1);
            cr.lineTo(x1, midline);
            cr.lineTo(x0, midline);
            cr.closePath();
            cr.fill();
        }

        // Short runs of line, so the colour can sweep along the wave.
        const run = 8;
        const stroke = (mirror, lineWidth, alpha) => {
            for (let start = 0; start < count - 1; start += run) {
                const end = Math.min(start + run, count - 1);
                const colour = this._sweep((start + end) / 2 / (count - 1));
                cr.moveTo(...point(start, trace[start] * mirror));
                for (let index = start + 1; index <= end; index++)
                    cr.lineTo(...point(index, trace[index] * mirror));
                cr.setSourceRGBA(
                    colour[0], colour[1], colour[2], alpha);
                cr.setLineWidth(lineWidth);
                cr.setLineCap(Cairo.LineCap.ROUND);
                cr.setLineJoin(Cairo.LineJoin.ROUND);
                cr.stroke();
            }
        };

        stroke(-0.6, 1.0, WAVE_ECHO_ALPHA);
        for (const [lineWidth, alpha] of WAVE_LAYERS)
            stroke(1.0, lineWidth, alpha);
    }
}
