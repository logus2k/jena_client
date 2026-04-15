/**
 * Jena Weather Forecast Client
 * Connects to the backend via socket.io for real-time model interaction.
 */

// Derive socket.io path from current page URL (works behind reverse proxy)
const basePath = window.location.pathname.replace(/\/$/, '');
const socket = io({
    path: basePath + '/socket.io/',
    transports: ['websocket', 'polling'],
});

// DOM elements
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const modelSelect = document.getElementById('modelSelect');
const versionSelect = document.getElementById('versionSelect');
const aliasSelect = document.getElementById('aliasSelect');
const modelSubtitle = document.getElementById('modelSubtitle');
const loadBtn = document.getElementById('loadBtn');
const modelInfo = document.getElementById('modelInfo');
const inputData = document.getElementById('inputData');
const sampleBtn = document.getElementById('sampleBtn');
const predictBtn = document.getElementById('predictBtn');
const logEntries = document.getElementById('logEntries');
const resultsTable = document.getElementById('resultsTable');

let chart = null;
let modelSchema = null;  // populated after model load from /api/schema
// Full version list for the currently-selected model, keyed by version
// string. Each entry: { version, aliases: [], run_id, creation_timestamp }.
// Populated by _loadVersionsForModel(). Used by the alias dropdown to
// resolve an alias back to a concrete version number.
let _versionsByName = [];
// Scaler stats for the currently-loaded model, populated from the run's
// MLflow params (`target_mean` / `target_std`). When both are present,
// predictions are de-standardized to real units before display:
//   celsius = raw * targetStd + targetMean
// When absent (older runs that did not log the stats), predictions are
// displayed as raw standardized values with a z-score label.
let targetMean = null;
let targetStd = null;
// Last rendered prediction unit, preserved across theme toggles so the
// chart label doesn't revert to 'degC' when the user flips dark/light.
let _lastUnit = 'degC';

// Theme toggle
const themeToggle = document.getElementById('themeToggle');
const savedTheme = localStorage.getItem('jena-theme') || 'light';
if (savedTheme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
themeToggle.textContent = savedTheme === 'dark' ? '\u263E' : '\u263C';

themeToggle.addEventListener('click', () => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (isDark) {
        document.documentElement.removeAttribute('data-theme');
        themeToggle.textContent = '\u263C';
        localStorage.setItem('jena-theme', 'light');
    } else {
        document.documentElement.setAttribute('data-theme', 'dark');
        themeToggle.textContent = '\u263E';
        localStorage.setItem('jena-theme', 'dark');
    }
    if (chart) renderChart(chart.data.datasets[0].data, _lastUnit);
});

// Logging
function log(message, type = 'info') {
    const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
    const entry = document.createElement('div');
    entry.innerHTML = `<span class="log-time">${time}</span> <span class="log-${type}">${message}</span>`;
    logEntries.prepend(entry);
    if (logEntries.children.length > 50) {
        logEntries.lastChild.remove();
    }
}

// Status updates
function setStatus(phase, message) {
    statusDot.className = 'status-dot ' + phase;
    statusText.textContent = message;
}

// Socket.IO events
socket.on('connect', () => {
    log('Connected to server', 'success');
    setStatus('connected', 'Connected');
});

socket.on('disconnect', () => {
    log('Disconnected from server', 'error');
    setStatus('', 'Disconnected');
    predictBtn.disabled = true;
});

socket.on('status', (data) => {
    setStatus(data.phase || 'info', data.message);
    log(data.message);
});

socket.on('model_loaded', async (data) => {
    log(`Model loaded: ${data.model_name} v${data.version}`, 'success');
    predictBtn.disabled = false;

    modelInfo.innerHTML = `
        <span class="label">Name:</span> ${data.model_name} |
        <span class="label">Version:</span> ${data.version} |
        <span class="label">Load time:</span> ${data.load_time.toFixed(2)}s
    `;

    // Reset scaler stats; will be refreshed from the run's MLflow params below.
    targetMean = null;
    targetStd = null;

    // Fetch model schema to adapt input generation dynamically
    try {
        const resp = await fetch(basePath + '/api/schema');
        if (resp.ok) {
            modelSchema = await resp.json();
            const shape = modelSchema.input_shape;
            if (shape) {
                log(`Model expects input shape: [${shape.join(', ')}]`, 'info');
            }
        }
    } catch (e) {
        log('Could not fetch model schema', 'warn');
    }

    // Fetch the run's MLflow params to get `target_mean` / `target_std`
    // so predictions can be de-standardized into real units on the client.
    // Runs that did not log these (older notebook versions) fall back to
    // displaying raw z-score predictions.
    if (data.run_id) {
        try {
            const resp = await fetch(basePath + '/api/run_params/' + encodeURIComponent(data.run_id));
            if (resp.ok) {
                const body = await resp.json();
                const params = body.params || {};
                if (params.target_mean !== undefined && params.target_std !== undefined) {
                    targetMean = parseFloat(params.target_mean);
                    targetStd = parseFloat(params.target_std);
                    log(`Scaler stats: mean=${targetMean.toFixed(3)}, std=${targetStd.toFixed(3)} - predictions will be de-standardized`, 'info');
                } else {
                    log('Run did not log target_mean / target_std - predictions will be shown as z-scores', 'warn');
                }
            }
        } catch (e) {
            log('Could not fetch run params', 'warn');
        }
    }
});

socket.on('prediction', (data) => {
    const raw = data.prediction;
    log(`Received ${raw.length}-hour forecast`, 'success');
    // Apply inverse scaling if the run logged target_mean/target_std.
    // Otherwise keep raw z-score values and label them as such.
    const hasScaler = targetMean !== null && targetStd !== null;
    const display = hasScaler
        ? raw.map(v => v * targetStd + targetMean)
        : raw;
    const unit = hasScaler ? 'degC' : 'z';
    _lastUnit = unit;
    renderChart(display, unit);
    renderTable(display, unit);
});

socket.on('error', (data) => {
    log(`Error: ${data.message}`, 'error');
});

// Chart rendering
function renderChart(predictions, unit = 'degC') {
    const ctx = document.getElementById('forecastChart');
    const labels = predictions.map((_, i) => `+${i + 1}h`);
    const cs = getComputedStyle(document.documentElement);
    const lineColor = cs.getPropertyValue('--chart-line').trim();
    const fillColor = cs.getPropertyValue('--chart-fill').trim();
    const gridColor = cs.getPropertyValue('--chart-grid').trim();
    const textColor = cs.getPropertyValue('--text-muted').trim();

    if (chart) chart.destroy();

    chart = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: unit === 'degC' ? 'Temperature (degC)' : 'Prediction (z-score)',
                data: predictions,
                borderColor: lineColor,
                backgroundColor: fillColor,
                fill: true,
                tension: 0.3,
                pointRadius: 3,
                pointBackgroundColor: lineColor,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (item) => `${item.parsed.y.toFixed(2)} degC`
                    }
                }
            },
            scales: {
                x: {
                    title: { display: true, text: 'Forecast Horizon', color: textColor },
                    ticks: { color: textColor },
                    grid: { color: gridColor },
                },
                y: {
                    title: { display: true, text: 'Temperature (degC)', color: textColor },
                    ticks: { color: textColor },
                    grid: { color: gridColor },
                }
            }
        }
    });
}

// Results table
function renderTable(predictions, unit = 'degC') {
    const header = unit === 'degC' ? 'Temperature' : 'Prediction (z)';
    let html = `<table><tr><th>Hour</th><th>${header}</th></tr>`;
    for (let i = 0; i < predictions.length; i++) {
        const suffix = unit === 'degC' ? ' degC' : '';
        html += `<tr><td>+${i + 1}h</td><td>${predictions[i].toFixed(2)}${suffix}</td></tr>`;
    }
    html += '</table>';
    resultsTable.innerHTML = html;
}

// Generate sample input data adapted to the loaded model's schema
function generateSample() {
    // Read dimensions from schema, fall back to defaults
    let timesteps = 120;
    let numFeatures = 11;
    if (modelSchema && modelSchema.input_shape) {
        const shape = modelSchema.input_shape;
        // shape is typically [batch, timesteps, features] or [timesteps, features]
        if (shape.length === 3) {
            timesteps = shape[1];
            numFeatures = shape[2];
        } else if (shape.length === 2) {
            timesteps = shape[0];
            numFeatures = shape[1];
        }
    }

    const data = [];
    let temp = (Math.random() - 0.5) * 2;  // standardized around 0

    for (let i = 0; i < timesteps; i++) {
        temp += (Math.random() - 0.5) * 0.1;
        const row = [parseFloat(temp.toFixed(4))];  // first feature: temperature-like
        for (let f = 1; f < numFeatures; f++) {
            row.push(parseFloat(((Math.random() - 0.5) * 1.0).toFixed(4)));
        }
        data.push(row);
    }
    return data;
}

// ── Model / Version / Alias dropdown population ──────────────────

// Fetch registered models from the backend and populate the model select.
// On success, auto-select the first model and load its versions.
async function _loadModels() {
    try {
        modelSelect.innerHTML = '';
        modelSelect.disabled = true;
        const resp = await fetch(basePath + '/api/models');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        const models = data.models || [];
        if (models.length === 0) {
            const opt = document.createElement('option');
            opt.textContent = '(no models registered)';
            modelSelect.appendChild(opt);
            log('No models registered in MLflow', 'warn');
            return;
        }
        for (const m of models) {
            const opt = document.createElement('option');
            opt.value = m.name;
            opt.textContent = m.name;
            modelSelect.appendChild(opt);
        }
        modelSelect.disabled = false;
        modelSelect.value = models[0].name;
        _updateSubtitle();
        await _loadVersionsForModel(models[0].name);
    } catch (e) {
        log(`Failed to load models: ${e.message}`, 'error');
    }
}

// Fetch versions for a given model and populate Version + Alias selects.
// Alias defaults to @champion if present, otherwise <no tag>.
async function _loadVersionsForModel(name) {
    try {
        versionSelect.innerHTML = '';
        aliasSelect.innerHTML = '';
        versionSelect.disabled = true;
        aliasSelect.disabled = true;

        const resp = await fetch(basePath + '/api/models/' + encodeURIComponent(name) + '/versions');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        _versionsByName = data.versions || [];

        if (_versionsByName.length === 0) {
            const opt = document.createElement('option');
            opt.textContent = '(no versions)';
            versionSelect.appendChild(opt);
            const opt2 = document.createElement('option');
            opt2.textContent = '<no tag>';
            aliasSelect.appendChild(opt2);
            loadBtn.disabled = true;
            return;
        }

        // Version dropdown: newest first, label includes aliases.
        for (const v of _versionsByName) {
            const opt = document.createElement('option');
            opt.value = v.version;
            const aliasSuffix = v.aliases.length ? ` (${v.aliases.map(a => '@' + a).join(', ')})` : '';
            opt.textContent = `v${v.version}${aliasSuffix}`;
            versionSelect.appendChild(opt);
        }
        versionSelect.disabled = false;

        // Alias dropdown: gather unique alias names from all versions.
        const allAliases = new Set();
        for (const v of _versionsByName) for (const a of v.aliases) allAliases.add(a);

        const noTagOpt = document.createElement('option');
        noTagOpt.value = '';
        noTagOpt.textContent = '<no tag>';
        aliasSelect.appendChild(noTagOpt);
        for (const a of Array.from(allAliases).sort()) {
            const opt = document.createElement('option');
            opt.value = a;
            opt.textContent = '@' + a;
            aliasSelect.appendChild(opt);
        }
        aliasSelect.disabled = false;

        // Default selection: @champion if present, else <no tag>.
        if (allAliases.has('champion')) {
            aliasSelect.value = 'champion';
            _alignVersionToAlias('champion');
        } else {
            aliasSelect.value = '';
            // Version defaults to whichever option the browser picked (first = newest).
        }

        loadBtn.disabled = false;
        _updateSubtitle();
    } catch (e) {
        log(`Failed to load versions for ${name}: ${e.message}`, 'error');
    }
}

// When the user picks an alias, flip the version dropdown to the version
// that alias points to so the final request is unambiguous.
function _alignVersionToAlias(aliasName) {
    if (!aliasName) return;
    const match = _versionsByName.find(v => v.aliases.includes(aliasName));
    if (match) versionSelect.value = match.version;
}

// Update the subtitle under the main title with the currently-selected
// model name and version, so the header always reflects the loaded state.
function _updateSubtitle() {
    const name = modelSelect.value || '';
    const version = versionSelect.value || '';
    if (!name) {
        modelSubtitle.textContent = '';
        return;
    }
    modelSubtitle.textContent = version ? `${name} v${version}` : name;
}

// Dropdown event wiring
modelSelect.addEventListener('change', () => {
    _updateSubtitle();
    _loadVersionsForModel(modelSelect.value);
});
versionSelect.addEventListener('change', () => {
    // Manual version pick invalidates any alias selection.
    aliasSelect.value = '';
    _updateSubtitle();
});
aliasSelect.addEventListener('change', () => {
    const a = aliasSelect.value;
    if (a) _alignVersionToAlias(a);
    _updateSubtitle();
});

// Clear any previous prediction output - called whenever a new model is
// loaded, because the old chart/table belonged to a different model and
// would otherwise mislead the user.
function _clearOutput() {
    if (chart) {
        chart.destroy();
        chart = null;
    }
    resultsTable.innerHTML = '';
    inputData.value = '';
    modelInfo.innerHTML = '';
}

// Event handlers
loadBtn.addEventListener('click', () => {
    const name = modelSelect.value;
    const version = versionSelect.value;
    if (!name) {
        log('No model selected', 'error');
        return;
    }
    if (!version) {
        log('No version selected', 'error');
        return;
    }
    _clearOutput();
    loadBtn.disabled = true;
    socket.emit('load_model', { model_name: name, version });
    socket.once('model_loaded', () => { loadBtn.disabled = false; });
    socket.once('error', () => { loadBtn.disabled = false; });
});

// Kick off model discovery as soon as the page is ready.
_loadModels();

sampleBtn.addEventListener('click', () => {
    const sample = generateSample();
    inputData.value = JSON.stringify(sample, null, 2);
    log(`Sample input loaded (${sample.length} timesteps, ${sample[0].length} features)`, 'info');
});

predictBtn.addEventListener('click', () => {
    let parsed;
    try {
        parsed = JSON.parse(inputData.value);
    } catch (e) {
        log('Invalid JSON input', 'error');
        return;
    }

    let expectedTimesteps = 120;
    if (modelSchema && modelSchema.input_shape) {
        const shape = modelSchema.input_shape;
        expectedTimesteps = shape.length === 3 ? shape[1] : shape[0];
    }
    if (!Array.isArray(parsed) || parsed.length !== expectedTimesteps) {
        log(`Expected ${expectedTimesteps} timesteps, got ${Array.isArray(parsed) ? parsed.length : 'invalid'}`, 'error');
        return;
    }

    predictBtn.disabled = true;
    socket.emit('predict', { data: { data: [parsed] } });
    socket.once('prediction', () => { predictBtn.disabled = false; });
    socket.once('error', () => { predictBtn.disabled = false; });
});
