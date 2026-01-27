/**
 * Nordic Energy Dashboard - Frontend Application
 * Version 5 - Fixed Chart.js type conflict
 */

// State
let selectedCountries = ['SE'];  // Start with just Sweden selected
let selectedDays = 1;  // Default to 24h since we have limited data
let statusChart = null;
let typesChart = null;

// Colors for countries and metrics
const countryColors = {
    SE: { main: '#3b82f6', light: 'rgba(59, 130, 246, 0.2)' },
    NO: { main: '#ef4444', light: 'rgba(239, 68, 68, 0.2)' },
    FI: { main: '#22c55e', light: 'rgba(34, 197, 94, 0.2)' },
    DK: { main: '#eab308', light: 'rgba(234, 179, 8, 0.2)' }
};

const statusColors = {
    production: '#ef4444',
    consumption: '#22c55e',
    import: '#eab308',
    export: '#3b82f6'
};

const typeColors = {
    nuclear: '#3b82f6',
    hydro: '#ef4444',
    wind: '#eab308',
    thermal: '#f97316',
    not_specified: '#8b5cf6'
};

// Chart.js default options for dark theme
Chart.defaults.color = '#a0a0a0';
Chart.defaults.borderColor = '#333333';

const chartOptions = {
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

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM loaded, initializing dashboard...');
    initializeControls();
    initializeCharts();
    loadData();
    loadStats();
});

function initializeControls() {
    // Country checkboxes - set initial state
    document.querySelectorAll('input[name="country"]').forEach(checkbox => {
        // Uncheck all except SE initially
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

    // Time selector buttons - set 24h as default active
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
        options: JSON.parse(JSON.stringify(chartOptions))
    });

    const typesCtx = document.getElementById('typesChart').getContext('2d');
    typesChart = new Chart(typesCtx, {
        type: 'line',
        data: { datasets: [] },
        options: JSON.parse(JSON.stringify(chartOptions))
    });
    
    console.log('Charts initialized');
}

// Helper function to parse timestamp
function parseTimestamp(ts) {
    if (!ts) return null;
    // Ensure ISO format
    let isoTs = ts;
    if (!ts.includes('T')) {
        isoTs = ts.replace(' ', 'T');
    }
    // Add Z for UTC if no timezone specified
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
        console.log('Fetching /api/current...');
        const currentResponse = await fetch('/api/current');
        if (!currentResponse.ok) {
            throw new Error(`Current API failed: ${currentResponse.status}`);
        }
        const currentData = await currentResponse.json();
        console.log('Current data:', currentData);
        renderCurrentValues(currentData);

        // Load historical data
        const statusDatasets = [];
        const typesDatasets = [];

        for (const country of selectedCountries) {
            console.log(`--- Fetching data for ${country} ---`);
            
            // Fetch status data
            try {
                const statusUrl = `/api/status/${country}?days=${selectedDays}`;
                console.log('Fetching:', statusUrl);
                const statusResponse = await fetch(statusUrl);
                
                if (!statusResponse.ok) {
                    console.error(`Status API failed for ${country}: ${statusResponse.status}`);
                    continue;
                }
                
                const statusData = await statusResponse.json();
                console.log(`Status data for ${country}: ${statusData.data?.length || 0} records`);
                
                if (statusData.data && statusData.data.length > 0) {
                    // Log raw data for debugging
                    console.log('First record:', statusData.data[0]);
                    console.log('Last record:', statusData.data[statusData.data.length - 1]);
                    
                    const countryName = statusData.country_name;
                    
                    // Process and validate data
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
                    
                    console.log(`Parsed ${productionData.length} valid data points for ${country}`);
                    if (productionData.length > 0) {
                        console.log('Sample parsed point:', productionData[0]);
                    }
                    
                    // Determine point radius based on data count
                    const pointRadius = productionData.length < 10 ? 6 : productionData.length < 50 ? 4 : 2;
                    
                    statusDatasets.push({
                        label: `${countryName} - Production`,
                        data: productionData,
                        borderColor: statusColors.production,
                        backgroundColor: statusColors.production,
                        borderWidth: 2,
                        tension: 0.3,
                        pointRadius: pointRadius,
                        pointHoverRadius: pointRadius + 2,
                        country: country,
                        metricType: 'production'
                    });

                    statusDatasets.push({
                        label: `${countryName} - Consumption`,
                        data: consumptionData,
                        borderColor: statusColors.consumption,
                        backgroundColor: statusColors.consumption,
                        borderWidth: 2,
                        tension: 0.3,
                        pointRadius: pointRadius,
                        pointHoverRadius: pointRadius + 2,
                        country: country,
                        metricType: 'consumption'
                    });

                    statusDatasets.push({
                        label: `${countryName} - Import`,
                        data: importData,
                        borderColor: statusColors.import,
                        backgroundColor: statusColors.import,
                        borderWidth: 2,
                        tension: 0.3,
                        pointRadius: pointRadius,
                        pointHoverRadius: pointRadius + 2,
                        country: country,
                        metricType: 'import'
                    });

                    statusDatasets.push({
                        label: `${countryName} - Export`,
                        data: exportData,
                        borderColor: statusColors.export,
                        backgroundColor: statusColors.export,
                        borderWidth: 2,
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
                console.log('Fetching:', typesUrl);
                const typesResponse = await fetch(typesUrl);
                
                if (!typesResponse.ok) {
                    console.error(`Types API failed for ${country}: ${typesResponse.status}`);
                    continue;
                }
                
                const typesData = await typesResponse.json();
                console.log(`Types data for ${country}: ${typesData.data?.length || 0} records`);

                if (typesData.data && typesData.data.length > 0) {
                    const countryName = typesData.country_name;
                    
                    // Process and validate data
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
                        borderColor: typeColors.nuclear,
                        backgroundColor: typeColors.nuclear,
                        borderWidth: 2,
                        tension: 0.3,
                        pointRadius: pointRadius,
                        pointHoverRadius: pointRadius + 2,
                        country: country,
                        metricType: 'nuclear'
                    });

                    typesDatasets.push({
                        label: `${countryName} - Hydro`,
                        data: hydroData,
                        borderColor: typeColors.hydro,
                        backgroundColor: typeColors.hydro,
                        borderWidth: 2,
                        tension: 0.3,
                        pointRadius: pointRadius,
                        pointHoverRadius: pointRadius + 2,
                        country: country,
                        metricType: 'hydro'
                    });

                    typesDatasets.push({
                        label: `${countryName} - Wind`,
                        data: windData,
                        borderColor: typeColors.wind,
                        backgroundColor: typeColors.wind,
                        borderWidth: 2,
                        tension: 0.3,
                        pointRadius: pointRadius,
                        pointHoverRadius: pointRadius + 2,
                        country: country,
                        metricType: 'wind'
                    });

                    typesDatasets.push({
                        label: `${countryName} - Thermal`,
                        data: thermalData,
                        borderColor: typeColors.thermal,
                        backgroundColor: typeColors.thermal,
                        borderWidth: 2,
                        tension: 0.3,
                        pointRadius: pointRadius,
                        pointHoverRadius: pointRadius + 2,
                        country: country,
                        metricType: 'thermal'
                    });

                    typesDatasets.push({
                        label: `${countryName} - Other`,
                        data: otherData,
                        borderColor: typeColors.not_specified,
                        backgroundColor: typeColors.not_specified,
                        borderWidth: 2,
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

        console.log('Total status datasets:', statusDatasets.length);
        console.log('Total types datasets:', typesDatasets.length);

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
        console.log('Status chart updated');

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
        console.log('Types chart updated');

        // Apply visibility settings
        updateStatusChartVisibility();
        updateTypesChartVisibility();

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
            // Parse and display in local timezone
            const date = parseTimestamp(stats.newest_record);
            if (date) {
                document.getElementById('lastUpdate').textContent = date.toLocaleString();
            }
        }
    } catch (error) {
        console.error('Error loading stats:', error);
    }
}

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
        if (!countryData) {
            console.log(`No current data for ${country}`);
            continue;
        }

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

function showLoading(show) {
    const overlay = document.getElementById('loadingOverlay');
    if (show) {
        overlay.classList.add('active');
    } else {
        overlay.classList.remove('active');
    }
}

function showToast(message, type = 'info') {
    // Remove existing toast
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

    // Trigger animation
    setTimeout(() => toast.classList.add('show'), 10);

    // Auto remove
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 5000);
}

// Auto-refresh every 5 minutes
setInterval(() => {
    console.log('Auto-refresh triggered');
    loadData();
    loadStats();
}, 5 * 60 * 1000);

console.log('Nordic Energy Dashboard v5 loaded');
