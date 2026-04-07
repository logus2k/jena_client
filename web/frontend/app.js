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
const modelName = document.getElementById('modelName');
const loadBtn = document.getElementById('loadBtn');
const modelInfo = document.getElementById('modelInfo');
const inputData = document.getElementById('inputData');
const sampleBtn = document.getElementById('sampleBtn');
const predictBtn = document.getElementById('predictBtn');
const logEntries = document.getElementById('logEntries');
const resultsTable = document.getElementById('resultsTable');

let chart = null;
let modelSchema = null;  // populated after model load from /api/schema

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
    if (chart) renderChart(chart.data.datasets[0].data);
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
});

socket.on('prediction', (data) => {
    const predictions = data.prediction;
    log(`Received ${predictions.length}-hour forecast`, 'success');
    renderChart(predictions);
    renderTable(predictions);
});

socket.on('error', (data) => {
    log(`Error: ${data.message}`, 'error');
});

// Chart rendering
function renderChart(predictions) {
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
                label: 'Temperature (degC)',
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
function renderTable(predictions) {
    let html = '<table><tr><th>Hour</th><th>Temperature</th></tr>';
    for (let i = 0; i < predictions.length; i++) {
        html += `<tr><td>+${i + 1}h</td><td>${predictions[i].toFixed(2)} degC</td></tr>`;
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

// Event handlers
loadBtn.addEventListener('click', () => {
    const name = modelName.value.trim();
    if (!name) return;
    loadBtn.disabled = true;
    socket.emit('load_model', { model_name: name });
    socket.once('model_loaded', () => { loadBtn.disabled = false; });
    socket.once('error', () => { loadBtn.disabled = false; });
});

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
