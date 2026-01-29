/**
 * Nordic Energy Dashboard - Frontend Application
 * Version 9 - Added Nordpool spot price correlation analysis
 */

// =============================================================================
// CONFIGURATION & STATE
// =============================================================================

const DEFAULT_SETTINGS = {
    defaultCountry: 'SE',
    defaultDays: 30
};

function loadSettings() {
    try {
        const saved = localStorage.getItem('nordicEnergySettings');
        if (saved) {
            return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
        }
    } catch (e) {
        console.warn('Failed to load settings:', e);
    }
    return DEFAULT_SETTINGS;
}

function saveSettings(settings) {
    try {
        localStorage.setItem('nordicEnergySettings', JSON.stringify(settings));
    } catch (e) {
        console.warn('Failed to save settings:', e);
    }
}

const settings = loadSettings();

// State
let selectedCountries = [settings.defaultCountry];
let selectedDays = settings.defaultDays;
let statusChart = null;
let typesChart = null;
let pieCharts = {};
let currentData = {};

// Price & correlation state
let priceChart = null;
let correlationChart = null;
let scatterChart = null;
let selectedZone = null;
let selectedEnergyType = 'wind';
let countryZones = {};

// =============================================================================
// COLOR SCHEMES
// =============================================================================

const statusColors = {
    production:  { border: '#ef4444', background: 'rgba(239, 68, 68, 0.2)' },
    consumption: { border: '#22c55e', background: 'rgba(34, 197, 94, 0.2)' },
    import:      { border: '#eab308', background: 'rgba(234, 179, 8, 0.2)' },
    export:      { border: '#3b82f6', background: 'rgba(59, 130, 246, 0.2)' }
};

const typeColors = {
    nuclear:       { border: '#3b82f6', background: 'rgba(59, 130, 246, 0.8)' },
    hydro:         { border: '#22c55e', background: 'rgba(34, 197, 94, 0.8)' },
    wind:          { border: '#eab308', background: 'rgba(234, 179, 8, 0.8)' },
    thermal:       { border: '#f97316', background: 'rgba(249, 115, 22, 0.8)' },
    not_specified: { border: '#8b5cf6', background: 'rgba(139, 92, 246, 0.8)' }
};

const priceColor = { border: '#06b6d4', background: 'rgba(6, 182, 212, 0.2)' };

const countryStyles = {
    SE: { name: 'Sweden',  lineStyle: [],             borderWidth: 2 },
    NO: { name: 'Norway',  lineStyle: [5, 5],         borderWidth: 2 },
    FI: { name: 'Finland', lineStyle: [2, 2],         borderWidth: 2 },
    DK: { name: 'Denmark', lineStyle: [10, 5, 2, 5],  borderWidth: 2 }
};

const typeLabels = {
    nuclear: 'Nuclear',
    hydro: 'Hydro',
    wind: 'Wind',
    thermal: 'Thermal',
    not_specified: 'Other'
};

// =============================================================================
// CHART.JS CONFIGURATION
// =============================================================================

Chart.register(ChartDataLabels);
Chart.defaults.plugins.datalabels = { display: false };
Chart.defaults.color = '#a0a0a0';
Chart.defaults.borderColor = '#333333';

const lineChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
        legend: { display: false },
        datalabels: { display: false },
        tooltip: {
            backgroundColor: 'rgba(30, 30, 30, 0.95)',
            titleColor: '#ffffff',
            bodyColor: '#a0a0a0',
            borderColor: '#333333',
            borderWidth: 1,
            padding: 12,
            displayColors: true,
            callbacks: {
                label: function(context) {
                    return `${context.dataset.label}: ${context.parsed.y?.toFixed(2) || 0} GW`;
                }
            }
        }
    },
    scales: {
        x: {
            type: 'time',
            time: {
                unit: 'hour',
                displayFormats: { hour: 'HH:mm', day: 'MMM d', week: 'MMM d' }
            },
            grid: { color: '#252525', drawBorder: false },
            ticks: { maxTicksLimit: 12 }
        },
        y: {
            beginAtZero: false,
            grid: { color: '#252525', drawBorder: false },
            ticks: {
                callback: function(value) { return value.toFixed(1) + ' GW'; }
            }
        }
    }
};

const pieChartOptions = {
    responsive: true,
    maintainAspectRatio: true,
    plugins: {
        legend: {
            display: true,
            position: 'bottom',
            labels: {
                color: '#a0a0a0', padding: 15, usePointStyle: true,
                pointStyle: 'circle', font: { size: 11 }
            }
        },
        datalabels: {
            display: true,
            color: '#ffffff',
            font: { weight: 'bold', size: 12 },
            formatter: (value, context) => {
                const dataset = context.chart.data.datasets[0];
                const total = dataset.data.reduce((acc, val) => acc + val, 0);
                if (total === 0 || value === 0) return '';
                const percentage = ((value / total) * 100).toFixed(1);
                if (percentage < 5) return '';
                return percentage + '%';
            },
            anchor: 'center', align: 'center', offset: 0,
            textShadowBlur: 4, textShadowColor: 'rgba(0, 0, 0, 0.5)'
        },
        tooltip: {
            backgroundColor: 'rgba(30, 30, 30, 0.95)',
            titleColor: '#ffffff', bodyColor: '#a0a0a0',
            borderColor: '#333333', borderWidth: 1, padding: 12,
            callbacks: {
                label: function(context) {
                    const value = context.parsed || 0;
                    const total = context.dataset.data.reduce((a, b) => a + b, 0);
                    const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
                    return `${context.label}: ${value.toFixed(2)} GW (${percentage}%)`;
                }
            }
        }
    }
};

// =============================================================================
// INITIALIZATION
// =============================================================================

document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM loaded, initializing dashboard...');
    initializeControls();
    initializeCharts();
    initializeCorrelationCharts();
    initializeSettingsModal();
    initializeCorrelationControls();
    loadData();
    loadStats();
});

function initializeControls() {
    document.querySelectorAll('input[name="country"]').forEach(checkbox => {
        checkbox.checked = selectedCountries.includes(checkbox.value);
        checkbox.addEventListener('change', (e) => {
            if (e.target.checked) {
                if (!selectedCountries.includes(e.target.value)) {
                    selectedCountries.push(e.target.value);
                }
            } else {
                selectedCountries = selectedCountries.filter(c => c !== e.target.value);
            }
            loadData();
            updateZoneSelector();
            loadCorrelationData();
        });
    });

    document.querySelectorAll('.time-btn').forEach(btn => {
        btn.classList.remove('active');
        if (parseInt(btn.dataset.days) === selectedDays) {
            btn.classList.add('active');
        }
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            selectedDays = parseInt(e.target.dataset.days);
            loadData();
            loadCorrelationData();
        });
    });

    document.getElementById('refreshBtn').addEventListener('click', () => {
        loadData();
        loadStats();
        loadCorrelationData();
    });

    document.querySelectorAll('#statusLegend input').forEach(checkbox => {
        checkbox.addEventListener('change', updateStatusChartVisibility);
    });

    document.querySelectorAll('#typesLegend input').forEach(checkbox => {
        checkbox.addEventListener('change', updateTypesChartVisibility);
    });
}

function initializeCharts() {
    const statusCtx = document.getElementById('statusChart').getContext('2d');
    statusChart = new Chart(statusCtx, {
        type: 'line',
        data: { datasets: [] },
        options: JSON.parse(JSON.stringify(lineChartOptions))
    });

    const typesCtx = document.getElementById('typesChart').getContext('2d');
    typesChart = new Chart(typesCtx, {
        type: 'line',
        data: { datasets: [] },
        options: JSON.parse(JSON.stringify(lineChartOptions))
    });
}

function initializeCorrelationCharts() {
    // Spot Price line chart
    const priceCtx = document.getElementById('priceChart').getContext('2d');
    const priceOpts = JSON.parse(JSON.stringify(lineChartOptions));
    priceOpts.plugins.tooltip.callbacks.label = function(context) {
        return `${context.dataset.label}: ${context.parsed.y?.toFixed(2) || 0} EUR/MWh`;
    };
    priceOpts.scales.y.ticks.callback = function(value) {
        return value.toFixed(0) + ' EUR';
    };
    priceChart = new Chart(priceCtx, {
        type: 'line',
        data: { datasets: [] },
        options: priceOpts
    });

    // Dual-axis correlation chart
    const corrCtx = document.getElementById('correlationChart').getContext('2d');
    correlationChart = new Chart(corrCtx, {
        type: 'line',
        data: { datasets: [] },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: true, position: 'top', labels: { color: '#a0a0a0', padding: 15 } },
                datalabels: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(30, 30, 30, 0.95)',
                    titleColor: '#ffffff', bodyColor: '#a0a0a0',
                    borderColor: '#333333', borderWidth: 1, padding: 12,
                    displayColors: true
                }
            },
            scales: {
                x: {
                    type: 'time',
                    time: { unit: 'hour', displayFormats: { hour: 'HH:mm', day: 'MMM d' } },
                    grid: { color: '#252525', drawBorder: false },
                    ticks: { maxTicksLimit: 12 }
                },
                y: {
                    type: 'linear',
                    position: 'left',
                    grid: { color: '#252525', drawBorder: false },
                    title: { display: true, text: 'GW', color: '#a0a0a0' },
                    ticks: { callback: v => v.toFixed(1) + ' GW' }
                },
                y1: {
                    type: 'linear',
                    position: 'right',
                    grid: { drawOnChartArea: false },
                    title: { display: true, text: 'EUR/MWh', color: '#a0a0a0' },
                    ticks: { callback: v => v.toFixed(0) + ' EUR' }
                }
            }
        }
    });

    // Scatter plot
    const scatterCtx = document.getElementById('scatterChart').getContext('2d');
    scatterChart = new Chart(scatterCtx, {
        type: 'scatter',
        data: { datasets: [] },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                datalabels: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(30, 30, 30, 0.95)',
                    titleColor: '#ffffff', bodyColor: '#a0a0a0',
                    borderColor: '#333333', borderWidth: 1, padding: 12,
                    callbacks: {
                        label: function(context) {
                            return `Energy: ${context.parsed.x?.toFixed(3)} GW | Price: ${context.parsed.y?.toFixed(2)} EUR/MWh`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    type: 'linear',
                    title: { display: true, text: 'Energy Production (GW)', color: '#a0a0a0' },
                    grid: { color: '#252525', drawBorder: false }
                },
                y: {
                    type: 'linear',
                    title: { display: true, text: 'Spot Price (EUR/MWh)', color: '#a0a0a0' },
                    grid: { color: '#252525', drawBorder: false }
                }
            }
        }
    });
}

function initializeCorrelationControls() {
    const zoneSelector = document.getElementById('zoneSelector');
    const energyTypeSelector = document.getElementById('energyTypeSelector');

    zoneSelector.addEventListener('change', (e) => {
        selectedZone = e.target.value;
        loadCorrelationData();
    });

    energyTypeSelector.addEventListener('change', (e) => {
        selectedEnergyType = e.target.value;
        loadCorrelationData();
    });

    // Load zones for the first selected country
    updateZoneSelector();
}

async function updateZoneSelector() {
    const zoneSelector = document.getElementById('zoneSelector');
    const country = selectedCountries[0] || 'SE';

    try {
        const response = await fetch(`/api/zones/${country}`);
        if (!response.ok) return;
        const data = await response.json();

        countryZones = data;
        zoneSelector.innerHTML = '';

        for (const zone of data.zones) {
            const opt = document.createElement('option');
            opt.value = zone;
            opt.textContent = zone;
            if (zone === data.default_zone) opt.selected = true;
            zoneSelector.appendChild(opt);
        }

        selectedZone = zoneSelector.value;
    } catch (err) {
        console.error('Failed to load zones:', err);
    }
}

function initializeSettingsModal() {
    let settingsBtn = document.getElementById('settingsBtn');
    if (!settingsBtn) {
        const header = document.querySelector('.header-right') || document.querySelector('header');
        if (header) {
            settingsBtn = document.createElement('button');
            settingsBtn.id = 'settingsBtn';
            settingsBtn.className = 'settings-btn';
            settingsBtn.innerHTML = `
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="3"></circle>
                    <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"></path>
                </svg>
            `;
            settingsBtn.title = 'Settings';
            header.insertBefore(settingsBtn, header.firstChild);
        }
    }

    if (!document.getElementById('settingsModal')) {
        const modal = document.createElement('div');
        modal.id = 'settingsModal';
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h3>Default Settings</h3>
                    <button class="modal-close">&times;</button>
                </div>
                <div class="modal-body">
                    <div class="form-group">
                        <label for="defaultCountry">Default Country</label>
                        <select id="defaultCountry">
                            <option value="SE">Sweden</option>
                            <option value="NO">Norway</option>
                            <option value="FI">Finland</option>
                            <option value="DK">Denmark</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label for="defaultDays">Default Time Range</label>
                        <select id="defaultDays">
                            <option value="1">24 Hours</option>
                            <option value="7">7 Days</option>
                            <option value="30">30 Days</option>
                            <option value="90">90 Days</option>
                            <option value="180">6 Months</option>
                        </select>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary modal-cancel">Cancel</button>
                    <button class="btn btn-primary modal-save">Save Defaults</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        document.getElementById('defaultCountry').value = settings.defaultCountry;
        document.getElementById('defaultDays').value = settings.defaultDays;

        modal.querySelector('.modal-close').addEventListener('click', () => modal.classList.remove('active'));
        modal.querySelector('.modal-cancel').addEventListener('click', () => modal.classList.remove('active'));
        modal.querySelector('.modal-save').addEventListener('click', () => {
            const newSettings = {
                defaultCountry: document.getElementById('defaultCountry').value,
                defaultDays: parseInt(document.getElementById('defaultDays').value)
            };
            saveSettings(newSettings);
            modal.classList.remove('active');
            showToast('Settings saved! They will apply on next page load.', 'success');
        });

        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.classList.remove('active');
        });
    }

    if (settingsBtn) {
        settingsBtn.addEventListener('click', () => {
            document.getElementById('settingsModal').classList.add('active');
        });
    }
}

// =============================================================================
// DATA LOADING
// =============================================================================

function parseTimestamp(ts) {
    if (!ts) return null;
    let isoTs = ts;
    if (!ts.includes('T')) isoTs = ts.replace(' ', 'T');
    if (!isoTs.includes('Z') && !isoTs.includes('+')) isoTs += 'Z';
    const date = new Date(isoTs);
    if (isNaN(date.getTime())) {
        console.error('Failed to parse timestamp:', ts);
        return null;
    }
    return date;
}

async function loadData() {
    showLoading(true);

    try {
        // Load current values
        const currentResponse = await fetch('/api/current');
        if (!currentResponse.ok) throw new Error(`Current API failed: ${currentResponse.status}`);
        currentData = await currentResponse.json();
        renderCurrentValues(currentData);

        // Load historical data
        const statusDatasets = [];
        const typesDatasets = [];

        for (const country of selectedCountries) {
            const countryStyle = countryStyles[country];

            // Fetch status data
            try {
                const statusResponse = await fetch(`/api/status/${country}?days=${selectedDays}`);
                if (!statusResponse.ok) continue;
                const statusData = await statusResponse.json();

                if (statusData.data && statusData.data.length > 0) {
                    const countryName = statusData.country_name;
                    const productionData = [], consumptionData = [], importData = [], exportData = [];

                    for (const d of statusData.data) {
                        const date = parseTimestamp(d.timestamp);
                        if (date) {
                            productionData.push({ x: date, y: d.production || 0 });
                            consumptionData.push({ x: date, y: d.consumption || 0 });
                            importData.push({ x: date, y: d.import || 0 });
                            exportData.push({ x: date, y: d.export || 0 });
                        }
                    }

                    const pointRadius = productionData.length < 10 ? 6 : productionData.length < 50 ? 4 : 2;
                    const baseProps = { borderWidth: 2, borderDash: countryStyle.lineStyle, tension: 0.3, pointRadius, pointHoverRadius: pointRadius + 2, country };

                    statusDatasets.push({ label: `${countryName} - Production`, data: productionData, borderColor: statusColors.production.border, backgroundColor: statusColors.production.background, ...baseProps, metricType: 'production' });
                    statusDatasets.push({ label: `${countryName} - Consumption`, data: consumptionData, borderColor: statusColors.consumption.border, backgroundColor: statusColors.consumption.background, ...baseProps, metricType: 'consumption' });
                    statusDatasets.push({ label: `${countryName} - Import`, data: importData, borderColor: statusColors.import.border, backgroundColor: statusColors.import.background, ...baseProps, metricType: 'import' });
                    statusDatasets.push({ label: `${countryName} - Export`, data: exportData, borderColor: statusColors.export.border, backgroundColor: statusColors.export.background, ...baseProps, metricType: 'export' });
                }
            } catch (err) {
                console.error(`Error fetching status for ${country}:`, err);
            }

            // Fetch types data
            try {
                const typesResponse = await fetch(`/api/types/${country}?days=${selectedDays}`);
                if (!typesResponse.ok) continue;
                const typesData = await typesResponse.json();

                if (typesData.data && typesData.data.length > 0) {
                    const countryName = typesData.country_name;
                    const nuclearData = [], hydroData = [], windData = [], thermalData = [], otherData = [];

                    for (const d of typesData.data) {
                        const date = parseTimestamp(d.timestamp);
                        if (date) {
                            nuclearData.push({ x: date, y: d.nuclear || 0 });
                            hydroData.push({ x: date, y: d.hydro || 0 });
                            windData.push({ x: date, y: d.wind || 0 });
                            thermalData.push({ x: date, y: d.thermal || 0 });
                            otherData.push({ x: date, y: d.not_specified || 0 });
                        }
                    }

                    const pointRadius = nuclearData.length < 10 ? 6 : nuclearData.length < 50 ? 4 : 2;
                    const baseProps = { borderWidth: 2, borderDash: countryStyle.lineStyle, tension: 0.3, pointRadius, pointHoverRadius: pointRadius + 2, country };

                    typesDatasets.push({ label: `${countryName} - Nuclear`, data: nuclearData, borderColor: typeColors.nuclear.border, backgroundColor: typeColors.nuclear.background, ...baseProps, metricType: 'nuclear' });
                    typesDatasets.push({ label: `${countryName} - Hydro`, data: hydroData, borderColor: typeColors.hydro.border, backgroundColor: typeColors.hydro.background, ...baseProps, metricType: 'hydro' });
                    typesDatasets.push({ label: `${countryName} - Wind`, data: windData, borderColor: typeColors.wind.border, backgroundColor: typeColors.wind.background, ...baseProps, metricType: 'wind' });
                    typesDatasets.push({ label: `${countryName} - Thermal`, data: thermalData, borderColor: typeColors.thermal.border, backgroundColor: typeColors.thermal.background, ...baseProps, metricType: 'thermal' });
                    typesDatasets.push({ label: `${countryName} - Other`, data: otherData, borderColor: typeColors.not_specified.border, backgroundColor: typeColors.not_specified.background, ...baseProps, metricType: 'not_specified' });
                }
            } catch (err) {
                console.error(`Error fetching types for ${country}:`, err);
            }
        }

        // Update status chart
        const timeUnit = selectedDays <= 7 ? 'hour' : 'day';
        statusChart.data.datasets = statusDatasets;
        statusChart.options.scales.x.time.unit = timeUnit;
        statusChart.update('none');

        typesChart.data.datasets = typesDatasets;
        typesChart.options.scales.x.time.unit = timeUnit;
        typesChart.update('none');

        updateStatusChartVisibility();
        updateTypesChartVisibility();
        updatePieCharts();

        // Also load correlation data
        loadCorrelationData();

    } catch (error) {
        console.error('loadData error:', error);
        showToast('Failed to load data. Check console for details.', 'error');
    }

    showLoading(false);
}

async function loadStats() {
    try {
        const response = await fetch('/api/stats');
        const stats = await response.json();
        document.getElementById('totalRecords').textContent = stats.total_records?.toLocaleString() || '0';
        if (stats.newest_record) {
            const date = parseTimestamp(stats.newest_record);
            if (date) document.getElementById('lastUpdate').textContent = date.toLocaleString();
        }
    } catch (error) {
        console.error('Error loading stats:', error);
    }
}

// =============================================================================
// CORRELATION DATA LOADING
// =============================================================================

async function loadCorrelationData() {
    const country = selectedCountries[0] || 'SE';
    const zone = selectedZone || '';
    const energyType = selectedEnergyType || 'wind';

    try {
        // Load price data, correlation data, and summary in parallel
        const [priceRes, corrRes, summaryRes] = await Promise.all([
            fetch(`/api/prices/${country}?days=${selectedDays}&zone=${zone}`),
            fetch(`/api/correlation/${country}?days=${selectedDays}&zone=${zone}&energy_type=${energyType}`),
            fetch(`/api/correlation/summary/${country}?days=${selectedDays}&zone=${zone}`)
        ]);

        // --- Spot Price Chart ---
        if (priceRes.ok) {
            const priceData = await priceRes.json();
            updatePriceChart(priceData);
        } else {
            priceChart.data.datasets = [];
            priceChart.update('none');
        }

        // --- Correlation + Scatter ---
        if (corrRes.ok) {
            const corrData = await corrRes.json();
            updateCorrelationChart(corrData);
            updateScatterChart(corrData);
        } else {
            correlationChart.data.datasets = [];
            correlationChart.update('none');
            scatterChart.data.datasets = [];
            scatterChart.update('none');
        }

        // --- Summary Cards ---
        if (summaryRes.ok) {
            const summaryData = await summaryRes.json();
            renderCorrelationSummary(summaryData);
        }

    } catch (err) {
        console.error('Correlation data load error:', err);
    }
}

function updatePriceChart(priceData) {
    if (!priceData.data || priceData.data.length === 0) {
        priceChart.data.datasets = [];
        priceChart.update('none');
        document.getElementById('priceChartSubtitle').textContent = 'No price data available';
        return;
    }

    const pointData = [];
    for (const d of priceData.data) {
        const date = parseTimestamp(d.timestamp);
        if (date) pointData.push({ x: date, y: d.price });
    }

    const pointRadius = pointData.length < 10 ? 6 : pointData.length < 50 ? 3 : 1;

    priceChart.data.datasets = [{
        label: `Spot Price (${priceData.zone || 'avg'})`,
        data: pointData,
        borderColor: priceColor.border,
        backgroundColor: priceColor.background,
        borderWidth: 2,
        tension: 0.3,
        pointRadius,
        pointHoverRadius: pointRadius + 2,
        fill: true
    }];

    const timeUnit = selectedDays <= 7 ? 'hour' : 'day';
    priceChart.options.scales.x.time.unit = timeUnit;
    priceChart.update('none');

    const subtitle = `${priceData.zone || 'avg'} | ${priceData.country_name}`;
    document.getElementById('priceChartSubtitle').textContent = subtitle;
}

function updateCorrelationChart(corrData) {
    if (!corrData.data || corrData.data.length === 0) {
        correlationChart.data.datasets = [];
        correlationChart.update('none');
        return;
    }

    const energyPoints = [];
    const pricePoints = [];

    for (const d of corrData.data) {
        const date = parseTimestamp(d.timestamp);
        if (date) {
            energyPoints.push({ x: date, y: d.energy_value });
            pricePoints.push({ x: date, y: d.price });
        }
    }

    const etLabel = typeLabels[corrData.energy_type] || corrData.energy_type;
    const etColor = typeColors[corrData.energy_type] || typeColors.wind;
    const pointRadius = energyPoints.length < 50 ? 3 : 1;

    correlationChart.data.datasets = [
        {
            label: `${etLabel} (GW)`,
            data: energyPoints,
            borderColor: etColor.border,
            backgroundColor: 'transparent',
            borderWidth: 2,
            tension: 0.3,
            pointRadius,
            yAxisID: 'y'
        },
        {
            label: `Spot Price (EUR/MWh)`,
            data: pricePoints,
            borderColor: priceColor.border,
            backgroundColor: 'transparent',
            borderWidth: 2,
            tension: 0.3,
            pointRadius,
            borderDash: [5, 5],
            yAxisID: 'y1'
        }
    ];

    const timeUnit = selectedDays <= 7 ? 'hour' : 'day';
    correlationChart.options.scales.x.time.unit = timeUnit;
    correlationChart.update('none');

    const r = corrData.correlation?.r;
    const subtitle = r !== null && r !== undefined
        ? `r = ${r.toFixed(4)} (${corrData.correlation.interpretation})`
        : 'Insufficient data';
    document.getElementById('correlationChartSubtitle').textContent = subtitle;
}

function updateScatterChart(corrData) {
    if (!corrData.data || corrData.data.length === 0) {
        scatterChart.data.datasets = [];
        scatterChart.update('none');
        document.getElementById('corrValueDisplay').textContent = '--';
        return;
    }

    const scatterPoints = corrData.data.map(d => ({ x: d.energy_value, y: d.price }));
    const etLabel = typeLabels[corrData.energy_type] || corrData.energy_type;
    const etColor = typeColors[corrData.energy_type] || typeColors.wind;

    // Calculate trend line (linear regression)
    const datasets = [{
        label: `${etLabel} vs Price`,
        data: scatterPoints,
        backgroundColor: etColor.background.replace('0.8', '0.5'),
        borderColor: etColor.border,
        pointRadius: 3,
        pointHoverRadius: 5
    }];

    // Add trend line if enough data
    if (scatterPoints.length >= 3) {
        const { slope, intercept } = linearRegression(scatterPoints);
        const xValues = scatterPoints.map(p => p.x);
        const xMin = Math.min(...xValues);
        const xMax = Math.max(...xValues);
        datasets.push({
            label: 'Trend',
            data: [
                { x: xMin, y: slope * xMin + intercept },
                { x: xMax, y: slope * xMax + intercept }
            ],
            borderColor: '#ef4444',
            borderWidth: 2,
            borderDash: [8, 4],
            pointRadius: 0,
            showLine: true,
            type: 'line'
        });
    }

    scatterChart.data.datasets = datasets;
    scatterChart.options.scales.x.title.text = `${etLabel} Production (GW)`;
    scatterChart.update('none');

    // Update correlation badge
    const r = corrData.correlation?.r;
    const badge = document.getElementById('correlationBadge');
    const display = document.getElementById('corrValueDisplay');
    if (r !== null && r !== undefined) {
        display.textContent = r.toFixed(4);
        badge.className = 'correlation-badge ' + getCorrelationClass(r);
    } else {
        display.textContent = '--';
        badge.className = 'correlation-badge';
    }
}

function linearRegression(points) {
    const n = points.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (const p of points) {
        sumX += p.x;
        sumY += p.y;
        sumXY += p.x * p.y;
        sumXX += p.x * p.x;
    }
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    return { slope, intercept };
}

function getCorrelationClass(r) {
    if (r === null || r === undefined) return '';
    const abs = Math.abs(r);
    if (abs >= 0.7) return r < 0 ? 'corr-strong-neg' : 'corr-strong-pos';
    if (abs >= 0.4) return r < 0 ? 'corr-moderate-neg' : 'corr-moderate-pos';
    if (abs >= 0.2) return r < 0 ? 'corr-weak-neg' : 'corr-weak-pos';
    return 'corr-negligible';
}

function renderCorrelationSummary(summaryData) {
    const container = document.getElementById('correlationSummary');
    if (!container) return;
    container.innerHTML = '';

    if (!summaryData || !summaryData.correlations) {
        container.innerHTML = '<p class="no-data-text">No correlation data available yet. Price data accumulates over time.</p>';
        return;
    }

    const types = ['wind', 'hydro', 'nuclear', 'thermal', 'not_specified'];

    for (const et of types) {
        const corr = summaryData.correlations[et];
        if (!corr) continue;

        const r = corr.r;
        const cssClass = getCorrelationClass(r);
        const label = typeLabels[et] || et;
        const color = typeColors[et] || typeColors.wind;

        const card = document.createElement('div');
        card.className = `correlation-card ${cssClass}`;
        card.innerHTML = `
            <div class="corr-card-header">
                <span class="corr-card-dot" style="background: ${color.border};"></span>
                <span class="corr-card-label">${label}</span>
            </div>
            <div class="corr-card-value">${r !== null ? r.toFixed(3) : 'N/A'}</div>
            <div class="corr-card-interp">${corr.interpretation}</div>
            <div class="corr-card-points">${corr.data_points} data points</div>
        `;
        container.appendChild(card);
    }
}

// =============================================================================
// RENDERING
// =============================================================================

function renderCurrentValues(data) {
    const container = document.getElementById('currentValues');
    container.innerHTML = '';

    const countryNames = { SE: 'Sweden', NO: 'Norway', FI: 'Finland', DK: 'Denmark' };

    for (const country of selectedCountries) {
        const countryData = data[country];
        if (!countryData) continue;

        const priceHtml = countryData.price
            ? `<div class="value-item value-item-full">
                    <span class="value-label">Spot Price (${countryData.price.zone})</span>
                    <span class="value-number price">${countryData.price.value?.toFixed(2) || '--'} ${countryData.price.currency || 'EUR'}/MWh</span>
               </div>`
            : '';

        const card = document.createElement('div');
        card.className = 'country-card';
        card.innerHTML = `
            <div class="country-card-header">
                <span class="flag flag-${country.toLowerCase()}"></span>
                <h3>${countryNames[country]}</h3>
            </div>
            <div class="country-card-values">
                <div class="value-item">
                    <span class="value-label">Production</span>
                    <span class="value-number production">${countryData.status?.production?.toFixed(2) || '0.00'} GW</span>
                </div>
                <div class="value-item">
                    <span class="value-label">Consumption</span>
                    <span class="value-number consumption">${countryData.status?.consumption?.toFixed(2) || '0.00'} GW</span>
                </div>
                <div class="value-item">
                    <span class="value-label">Import</span>
                    <span class="value-number import">${countryData.status?.import?.toFixed(2) || '0.00'} GW</span>
                </div>
                <div class="value-item">
                    <span class="value-label">Export</span>
                    <span class="value-number export">${countryData.status?.export?.toFixed(2) || '0.00'} GW</span>
                </div>
                ${priceHtml}
            </div>
        `;
        container.appendChild(card);
    }
}

function updatePieCharts() {
    const container = document.getElementById('pieChartsContainer');
    if (!container) return;

    Object.values(pieCharts).forEach(chart => chart.destroy());
    pieCharts = {};
    container.innerHTML = '';

    for (const country of selectedCountries) {
        const countryData = currentData[country];
        if (!countryData || !countryData.types) continue;

        const types = countryData.types;
        const countryName = countryStyles[country].name;

        const wrapper = document.createElement('div');
        wrapper.className = 'pie-chart-wrapper';
        wrapper.innerHTML = `
            <h4 class="pie-chart-title">
                <span class="flag flag-${country.toLowerCase()}"></span>
                ${countryName} - Energy Mix
            </h4>
            <div class="pie-chart-container">
                <canvas id="pieChart-${country}"></canvas>
            </div>
        `;
        container.appendChild(wrapper);

        const ctx = document.getElementById(`pieChart-${country}`).getContext('2d');
        pieCharts[country] = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: [typeLabels.nuclear, typeLabels.hydro, typeLabels.wind, typeLabels.thermal, typeLabels.not_specified],
                datasets: [{
                    data: [types.nuclear || 0, types.hydro || 0, types.wind || 0, types.thermal || 0, types.not_specified || 0],
                    backgroundColor: [typeColors.nuclear.background, typeColors.hydro.background, typeColors.wind.background, typeColors.thermal.background, typeColors.not_specified.background],
                    borderColor: [typeColors.nuclear.border, typeColors.hydro.border, typeColors.wind.border, typeColors.thermal.border, typeColors.not_specified.border],
                    borderWidth: 2
                }]
            },
            options: pieChartOptions
        });
    }
}

// =============================================================================
// CHART VISIBILITY
// =============================================================================

function updateStatusChartVisibility() {
    const visibleTypes = [];
    document.querySelectorAll('#statusLegend input:checked').forEach(cb => visibleTypes.push(cb.dataset.type));
    statusChart.data.datasets.forEach((dataset, index) => {
        const isVisible = visibleTypes.includes(dataset.metricType) && selectedCountries.includes(dataset.country);
        statusChart.setDatasetVisibility(index, isVisible);
    });
    statusChart.update('none');
}

function updateTypesChartVisibility() {
    const visibleTypes = [];
    document.querySelectorAll('#typesLegend input:checked').forEach(cb => visibleTypes.push(cb.dataset.type));
    typesChart.data.datasets.forEach((dataset, index) => {
        const isVisible = visibleTypes.includes(dataset.metricType) && selectedCountries.includes(dataset.country);
        typesChart.setDatasetVisibility(index, isVisible);
    });
    typesChart.update('none');
}

// =============================================================================
// UI HELPERS
// =============================================================================

function showLoading(show) {
    const overlay = document.getElementById('loadingOverlay');
    if (show) overlay.classList.add('active');
    else overlay.classList.remove('active');
}

function showToast(message, type = 'info') {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
            ${type === 'success'
                ? '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline>'
                : '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line>'
            }
        </svg>
        <span>${message}</span>
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 5000);
}

// =============================================================================
// AUTO-REFRESH
// =============================================================================

setInterval(() => {
    loadData();
    loadStats();
}, 5 * 60 * 1000);

console.log('Nordic Energy Dashboard v9 loaded (with Nordpool correlation)');
