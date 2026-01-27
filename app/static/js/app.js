/**
 * Nordic Energy Dashboard - Frontend Application
 * Version 8 - Fixed color scheme to match legend
 */

// =============================================================================
// CONFIGURATION & STATE
// =============================================================================

// Default settings (can be changed via UI)
const DEFAULT_SETTINGS = {
    defaultCountry: 'SE',
    defaultDays: 30
};

// Load settings from localStorage or use defaults
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

// =============================================================================
// COLOR SCHEMES
// =============================================================================

// Metric colors (consistent across all countries - matches legend)
const statusColors = {
    production:  { border: '#ef4444', background: 'rgba(239, 68, 68, 0.2)' },    // Red
    consumption: { border: '#22c55e', background: 'rgba(34, 197, 94, 0.2)' },    // Green
    import:      { border: '#eab308', background: 'rgba(234, 179, 8, 0.2)' },    // Yellow
    export:      { border: '#3b82f6', background: 'rgba(59, 130, 246, 0.2)' }    // Blue
};

// Energy type colors (consistent across all pie charts)
const typeColors = {
    nuclear:       { border: '#3b82f6', background: 'rgba(59, 130, 246, 0.8)' },
    hydro:         { border: '#22c55e', background: 'rgba(34, 197, 94, 0.8)' },
    wind:          { border: '#eab308', background: 'rgba(234, 179, 8, 0.8)' },
    thermal:       { border: '#f97316', background: 'rgba(249, 115, 22, 0.8)' },
    not_specified: { border: '#8b5cf6', background: 'rgba(139, 92, 246, 0.8)' }
};

// Country-specific line styles (to differentiate countries on the same chart)
const countryStyles = {
    SE: {
        name: 'Sweden',
        lineStyle: [],           // Solid
        borderWidth: 2
    },
    NO: {
        name: 'Norway',
        lineStyle: [5, 5],       // Dashed
        borderWidth: 2
    },
    FI: {
        name: 'Finland',
        lineStyle: [2, 2],       // Dotted
        borderWidth: 2
    },
    DK: {
        name: 'Denmark',
        lineStyle: [10, 5, 2, 5], // Dash-dot
        borderWidth: 2
    }
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

// Register the datalabels plugin for pie charts
Chart.register(ChartDataLabels);

// Disable datalabels globally (we'll enable it only for pie charts)
Chart.defaults.plugins.datalabels = { display: false };

Chart.defaults.color = '#a0a0a0';
Chart.defaults.borderColor = '#333333';

const lineChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
        mode: 'index',
        intersect: false
    },
    plugins: {
        legend: {
            display: false
        },
        datalabels: {
            display: false  // Disable for line charts
        },
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
                displayFormats: {
                    hour: 'HH:mm',
                    day: 'MMM d',
                    week: 'MMM d'
                }
            },
            grid: {
                color: '#252525',
                drawBorder: false
            },
            ticks: {
                maxTicksLimit: 12
            }
        },
        y: {
            beginAtZero: false,
            grid: {
                color: '#252525',
                drawBorder: false
            },
            ticks: {
                callback: function(value) {
                    return value.toFixed(1) + ' GW';
                }
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
                color: '#a0a0a0',
                padding: 15,
                usePointStyle: true,
                pointStyle: 'circle',
                font: {
                    size: 11
                }
            }
        },
        datalabels: {
            display: true,
            color: '#ffffff',
            font: {
                weight: 'bold',
                size: 12
            },
            formatter: (value, context) => {
                const dataset = context.chart.data.datasets[0];
                const total = dataset.data.reduce((acc, val) => acc + val, 0);
                if (total === 0 || value === 0) return '';
                const percentage = ((value / total) * 100).toFixed(1);
                if (percentage < 5) return '';  // Hide small percentages to avoid clutter
                return percentage + '%';
            },
            anchor: 'center',
            align: 'center',
            offset: 0,
            textShadowBlur: 4,
            textShadowColor: 'rgba(0, 0, 0, 0.5)'
        },
        tooltip: {
            backgroundColor: 'rgba(30, 30, 30, 0.95)',
            titleColor: '#ffffff',
            bodyColor: '#a0a0a0',
            borderColor: '#333333',
            borderWidth: 1,
            padding: 12,
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
    console.log('Settings:', settings);
    
    initializeControls();
    initializeCharts();
    initializeSettingsModal();
    loadData();
    loadStats();
});

function initializeControls() {
    // Country checkboxes - set initial state from settings
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
            console.log('Countries changed:', selectedCountries);
            loadData();
        });
    });

    // Time selector buttons - set from settings
    document.querySelectorAll('.time-btn').forEach(btn => {
        btn.classList.remove('active');
        if (parseInt(btn.dataset.days) === selectedDays) {
            btn.classList.add('active');
        }
        
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            selectedDays = parseInt(e.target.dataset.days);
            console.log('Days changed:', selectedDays);
            loadData();
        });
    });

    // Refresh button
    document.getElementById('refreshBtn').addEventListener('click', () => {
        console.log('Refresh clicked');
        loadData();
        loadStats();
    });

    // Legend checkboxes for status chart
    document.querySelectorAll('#statusLegend input').forEach(checkbox => {
        checkbox.addEventListener('change', updateStatusChartVisibility);
    });

    // Legend checkboxes for types chart
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
    
    console.log('Line charts initialized');
}

function initializeSettingsModal() {
    // Check if settings button exists, if not create it
    let settingsBtn = document.getElementById('settingsBtn');
    if (!settingsBtn) {
        // Add settings button to header
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

    // Create modal if it doesn't exist
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

        // Set current values
        document.getElementById('defaultCountry').value = settings.defaultCountry;
        document.getElementById('defaultDays').value = settings.defaultDays;

        // Event listeners
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

        // Close on backdrop click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.classList.remove('active');
            }
        });
    }

    // Settings button click
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
    if (!ts.includes('T')) {
        isoTs = ts.replace(' ', 'T');
    }
    if (!isoTs.includes('Z') && !isoTs.includes('+')) {
        isoTs += 'Z';
    }
    const date = new Date(isoTs);
    if (isNaN(date.getTime())) {
        console.error('Failed to parse timestamp:', ts);
        return null;
    }
    return date;
}

async function loadData() {
    showLoading(true);
    console.log('=== loadData START ===');
    console.log('Selected countries:', selectedCountries);
    console.log('Selected days:', selectedDays);

    try {
        // Load current values
        const currentResponse = await fetch('/api/current');
        if (!currentResponse.ok) {
            throw new Error(`Current API failed: ${currentResponse.status}`);
        }
        currentData = await currentResponse.json();
        console.log('Current data:', currentData);
        renderCurrentValues(currentData);

        // Load historical data
        const statusDatasets = [];
        const typesDatasets = [];

        for (const country of selectedCountries) {
            console.log(`--- Fetching data for ${country} ---`);
            const countryStyle = countryStyles[country];
            
            // Fetch status data
            try {
                const statusUrl = `/api/status/${country}?days=${selectedDays}`;
                const statusResponse = await fetch(statusUrl);
                
                if (!statusResponse.ok) {
                    console.error(`Status API failed for ${country}: ${statusResponse.status}`);
                    continue;
                }
                
                const statusData = await statusResponse.json();
                console.log(`Status data for ${country}: ${statusData.data?.length || 0} records`);
                
                if (statusData.data && statusData.data.length > 0) {
                    const countryName = statusData.country_name;
                    
                    const productionData = [];
                    const consumptionData = [];
                    const importData = [];
                    const exportData = [];
                    
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
                    
                    statusDatasets.push({
                        label: `${countryName} - Production`,
                        data: productionData,
                        borderColor: statusColors.production.border,
                        backgroundColor: statusColors.production.background,
                        borderWidth: 2,
                        borderDash: countryStyle.lineStyle,
                        tension: 0.3,
                        pointRadius: pointRadius,
                        pointHoverRadius: pointRadius + 2,
                        country: country,
                        metricType: 'production'
                    });

                    statusDatasets.push({
                        label: `${countryName} - Consumption`,
                        data: consumptionData,
                        borderColor: statusColors.consumption.border,
                        backgroundColor: statusColors.consumption.background,
                        borderWidth: 2,
                        borderDash: countryStyle.lineStyle,
                        tension: 0.3,
                        pointRadius: pointRadius,
                        pointHoverRadius: pointRadius + 2,
                        country: country,
                        metricType: 'consumption'
                    });

                    statusDatasets.push({
                        label: `${countryName} - Import`,
                        data: importData,
                        borderColor: statusColors.import.border,
                        backgroundColor: statusColors.import.background,
                        borderWidth: 2,
                        borderDash: countryStyle.lineStyle,
                        tension: 0.3,
                        pointRadius: pointRadius,
                        pointHoverRadius: pointRadius + 2,
                        country: country,
                        metricType: 'import'
                    });

                    statusDatasets.push({
                        label: `${countryName} - Export`,
                        data: exportData,
                        borderColor: statusColors.export.border,
                        backgroundColor: statusColors.export.background,
                        borderWidth: 2,
                        borderDash: countryStyle.lineStyle,
                        tension: 0.3,
                        pointRadius: pointRadius,
                        pointHoverRadius: pointRadius + 2,
                        country: country,
                        metricType: 'export'
                    });
                }
            } catch (err) {
                console.error(`Error fetching status for ${country}:`, err);
            }

            // Fetch types data
            try {
                const typesUrl = `/api/types/${country}?days=${selectedDays}`;
                const typesResponse = await fetch(typesUrl);
                
                if (!typesResponse.ok) {
                    console.error(`Types API failed for ${country}: ${typesResponse.status}`);
                    continue;
                }
                
                const typesData = await typesResponse.json();
                console.log(`Types data for ${country}: ${typesData.data?.length || 0} records`);

                if (typesData.data && typesData.data.length > 0) {
                    const countryName = typesData.country_name;
                    
                    const nuclearData = [];
                    const hydroData = [];
                    const windData = [];
                    const thermalData = [];
                    const otherData = [];
                    
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

                    typesDatasets.push({
                        label: `${countryName} - Nuclear`,
                        data: nuclearData,
                        borderColor: typeColors.nuclear.border,
                        backgroundColor: typeColors.nuclear.background,
                        borderWidth: 2,
                        borderDash: countryStyle.lineStyle,
                        tension: 0.3,
                        pointRadius: pointRadius,
                        pointHoverRadius: pointRadius + 2,
                        country: country,
                        metricType: 'nuclear'
                    });

                    typesDatasets.push({
                        label: `${countryName} - Hydro`,
                        data: hydroData,
                        borderColor: typeColors.hydro.border,
                        backgroundColor: typeColors.hydro.background,
                        borderWidth: 2,
                        borderDash: countryStyle.lineStyle,
                        tension: 0.3,
                        pointRadius: pointRadius,
                        pointHoverRadius: pointRadius + 2,
                        country: country,
                        metricType: 'hydro'
                    });

                    typesDatasets.push({
                        label: `${countryName} - Wind`,
                        data: windData,
                        borderColor: typeColors.wind.border,
                        backgroundColor: typeColors.wind.background,
                        borderWidth: 2,
                        borderDash: countryStyle.lineStyle,
                        tension: 0.3,
                        pointRadius: pointRadius,
                        pointHoverRadius: pointRadius + 2,
                        country: country,
                        metricType: 'wind'
                    });

                    typesDatasets.push({
                        label: `${countryName} - Thermal`,
                        data: thermalData,
                        borderColor: typeColors.thermal.border,
                        backgroundColor: typeColors.thermal.background,
                        borderWidth: 2,
                        borderDash: countryStyle.lineStyle,
                        tension: 0.3,
                        pointRadius: pointRadius,
                        pointHoverRadius: pointRadius + 2,
                        country: country,
                        metricType: 'thermal'
                    });

                    typesDatasets.push({
                        label: `${countryName} - Other`,
                        data: otherData,
                        borderColor: typeColors.not_specified.border,
                        backgroundColor: typeColors.not_specified.background,
                        borderWidth: 2,
                        borderDash: countryStyle.lineStyle,
                        tension: 0.3,
                        pointRadius: pointRadius,
                        pointHoverRadius: pointRadius + 2,
                        country: country,
                        metricType: 'not_specified'
                    });
                }
            } catch (err) {
                console.error(`Error fetching types for ${country}:`, err);
            }
        }

        // Update status chart
        statusChart.data.datasets = statusDatasets;
        if (selectedDays <= 1) {
            statusChart.options.scales.x.time.unit = 'hour';
        } else if (selectedDays <= 7) {
            statusChart.options.scales.x.time.unit = 'hour';
        } else {
            statusChart.options.scales.x.time.unit = 'day';
        }
        statusChart.update('none');

        // Update types chart
        typesChart.data.datasets = typesDatasets;
        if (selectedDays <= 1) {
            typesChart.options.scales.x.time.unit = 'hour';
        } else if (selectedDays <= 7) {
            typesChart.options.scales.x.time.unit = 'hour';
        } else {
            typesChart.options.scales.x.time.unit = 'day';
        }
        typesChart.update('none');

        // Update visibility
        updateStatusChartVisibility();
        updateTypesChartVisibility();

        // Update pie charts
        updatePieCharts();

        console.log('=== loadData SUCCESS ===');

    } catch (error) {
        console.error('=== loadData ERROR ===', error);
        showToast('Failed to load data. Check console for details.', 'error');
    }

    showLoading(false);
}

async function loadStats() {
    try {
        const response = await fetch('/api/stats');
        const stats = await response.json();
        console.log('Stats:', stats);

        document.getElementById('totalRecords').textContent = stats.total_records?.toLocaleString() || '0';
        
        if (stats.newest_record) {
            const date = parseTimestamp(stats.newest_record);
            if (date) {
                document.getElementById('lastUpdate').textContent = date.toLocaleString();
            }
        }
    } catch (error) {
        console.error('Error loading stats:', error);
    }
}

// =============================================================================
// RENDERING
// =============================================================================

function renderCurrentValues(data) {
    const container = document.getElementById('currentValues');
    container.innerHTML = '';

    const countryNames = {
        SE: 'Sweden',
        NO: 'Norway',
        FI: 'Finland',
        DK: 'Denmark'
    };

    for (const country of selectedCountries) {
        const countryData = data[country];
        if (!countryData) continue;

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
            </div>
        `;
        container.appendChild(card);
    }
}

function updatePieCharts() {
    const container = document.getElementById('pieChartsContainer');
    if (!container) {
        console.warn('Pie charts container not found');
        return;
    }

    // Clear existing pie charts
    Object.values(pieCharts).forEach(chart => chart.destroy());
    pieCharts = {};
    container.innerHTML = '';

    // Create a pie chart for each selected country
    for (const country of selectedCountries) {
        const countryData = currentData[country];
        if (!countryData || !countryData.types) continue;

        const types = countryData.types;
        const countryName = countryStyles[country].name;

        // Create wrapper
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

        // Create pie chart
        const ctx = document.getElementById(`pieChart-${country}`).getContext('2d');
        const chartData = {
            labels: [
                typeLabels.nuclear,
                typeLabels.hydro,
                typeLabels.wind,
                typeLabels.thermal,
                typeLabels.not_specified
            ],
            datasets: [{
                data: [
                    types.nuclear || 0,
                    types.hydro || 0,
                    types.wind || 0,
                    types.thermal || 0,
                    types.not_specified || 0
                ],
                backgroundColor: [
                    typeColors.nuclear.background,
                    typeColors.hydro.background,
                    typeColors.wind.background,
                    typeColors.thermal.background,
                    typeColors.not_specified.background
                ],
                borderColor: [
                    typeColors.nuclear.border,
                    typeColors.hydro.border,
                    typeColors.wind.border,
                    typeColors.thermal.border,
                    typeColors.not_specified.border
                ],
                borderWidth: 2
            }]
        };

        pieCharts[country] = new Chart(ctx, {
            type: 'doughnut',
            data: chartData,
            options: pieChartOptions
        });
    }
}

// =============================================================================
// CHART VISIBILITY
// =============================================================================

function updateStatusChartVisibility() {
    const visibleTypes = [];
    document.querySelectorAll('#statusLegend input:checked').forEach(cb => {
        visibleTypes.push(cb.dataset.type);
    });

    statusChart.data.datasets.forEach((dataset, index) => {
        const isVisible = visibleTypes.includes(dataset.metricType) && selectedCountries.includes(dataset.country);
        statusChart.setDatasetVisibility(index, isVisible);
    });
    statusChart.update('none');
}

function updateTypesChartVisibility() {
    const visibleTypes = [];
    document.querySelectorAll('#typesLegend input:checked').forEach(cb => {
        visibleTypes.push(cb.dataset.type);
    });

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
    if (show) {
        overlay.classList.add('active');
    } else {
        overlay.classList.remove('active');
    }
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
    console.log('Auto-refresh triggered');
    loadData();
    loadStats();
}, 5 * 60 * 1000);

console.log('Nordic Energy Dashboard v8 loaded');
