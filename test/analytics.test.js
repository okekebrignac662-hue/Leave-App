/**
 * test/analytics.test.js
 * Automated Test Suite for Leave Analytics & Visual Charts Dashboard
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

let app;
let server;
const PORT = 3992;
const BASE_URL = `http://localhost:${PORT}`;

function makeRequest(reqPath, options = {}) {
  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}${reqPath}`;
    const parsed = new URL(url);

    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    const req = http.request(reqOptions, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(body);
        } catch (e) {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body,
          json
        });
      });
    });

    req.on('error', reject);

    if (options.body) {
      const data = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      req.write(data);
    }
    req.end();
  });
}

async function runTests() {
  console.log('\n📈 Starting Leave Analytics & Visual Charts Verification Tests...\n');
  let passed = 0;
  let total = 0;

  function assert(condition, message) {
    total++;
    if (condition) {
      console.log(`✅ [PASS] ${message}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${message}`);
      process.exitCode = 1;
    }
  }

  try {
    // 1. Verify frontend UI elements exist in index.html
    console.log('1️⃣  Verifying UI Components in public/index.html...');
    const htmlContent = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');
    
    assert(htmlContent.includes('chart.umd.min.js'), 'index.html includes Chart.js CDN library');
    assert(htmlContent.includes('id="tab-sup-analytics"'), 'index.html contains #tab-sup-analytics tab button');
    assert(htmlContent.includes('id="supervisor-analytics-container"'), 'index.html contains #supervisor-analytics-container');
    assert(htmlContent.includes('id="analytics-filter-year"'), 'index.html contains #analytics-filter-year select');
    assert(htmlContent.includes('id="analytics-filter-dept"'), 'index.html contains #analytics-filter-dept select');
    assert(htmlContent.includes('id="analytics-filter-shift"'), 'index.html contains #analytics-filter-shift select');
    
    assert(htmlContent.includes('id="kpi-total-days"'), 'index.html contains #kpi-total-days KPI card');
    assert(htmlContent.includes('id="kpi-total-requests"'), 'index.html contains #kpi-total-requests KPI card');
    assert(htmlContent.includes('id="kpi-pending-requests"'), 'index.html contains #kpi-pending-requests KPI card');
    assert(htmlContent.includes('id="kpi-sick-rate"'), 'index.html contains #kpi-sick-rate KPI card');
    assert(htmlContent.includes('id="kpi-peak-day"'), 'index.html contains #kpi-peak-day KPI card');
    assert(htmlContent.includes('id="kpi-peak-month"'), 'index.html contains #kpi-peak-month KPI card');

    assert(htmlContent.includes('id="chart-monthly-trend"'), 'index.html contains #chart-monthly-trend canvas');
    assert(htmlContent.includes('id="chart-leave-types"'), 'index.html contains #chart-leave-types canvas');
    assert(htmlContent.includes('id="chart-day-of-week"'), 'index.html contains #chart-day-of-week canvas');
    assert(htmlContent.includes('id="chart-dept-shift"'), 'index.html contains #chart-dept-shift canvas');

    assert(htmlContent.includes('initAnalyticsTab'), 'index.html defines initAnalyticsTab function');
    assert(htmlContent.includes('loadAnalyticsData'), 'index.html defines loadAnalyticsData function');
    assert(htmlContent.includes('renderAnalyticsCharts'), 'index.html defines renderAnalyticsCharts function');
    assert(htmlContent.includes('destroyAnalyticsCharts'), 'index.html defines destroyAnalyticsCharts function');

    // 2. Start server
    console.log('\n2️⃣  Starting test server on port ' + PORT + '...');
    process.env.PORT = PORT;
    const googleSheetsService = require('../src/googleSheetsService');
    googleSheetsService.syncLeaveRequestAsync = () => {};
    googleSheetsService.syncEmployeeAsync = () => {};

    const serverModule = require('../src/server.js');
    app = serverModule.app;
    server = serverModule.server;
    await new Promise((r) => setTimeout(r, 1000));

    // 3. Test GET /api/analytics/summary (General company overview)
    console.log('\n3️⃣  Testing GET /api/analytics/summary endpoint...');
    const currentYear = new Date().getFullYear();
    const res = await makeRequest(`/api/analytics/summary?year=${currentYear}`);
    assert(res.status === 200, `GET /api/analytics/summary returns HTTP 200 (Got ${res.status})`);
    assert(res.json && res.json.success === true, 'Response has success: true');
    assert(res.json && res.json.summary !== undefined, 'Response contains summary metrics object');
    assert(typeof res.json.summary.totalApprovedDays === 'number', 'summary.totalApprovedDays is a number');
    assert(typeof res.json.summary.totalApprovedRequests === 'number', 'summary.totalApprovedRequests is a number');
    assert(typeof res.json.summary.pendingRequests === 'number', 'summary.pendingRequests is a number');
    assert(typeof res.json.summary.sickLeaveRate === 'number', 'summary.sickLeaveRate is a percentage number');
    assert(typeof res.json.summary.peakDayOfWeek === 'string', 'summary.peakDayOfWeek is a string');
    assert(typeof res.json.summary.peakMonth === 'string', 'summary.peakMonth is a string');

    // 4. Test Monthly Trend Array
    console.log('\n4️⃣  Testing Monthly Trend 12-Month Array...');
    assert(Array.isArray(res.json.monthlyTrend), 'monthlyTrend is an array');
    assert(res.json.monthlyTrend.length === 12, 'monthlyTrend contains exactly 12 months');
    const jan = res.json.monthlyTrend[0];
    assert(jan && jan.month === 1 && typeof jan.monthName === 'string', 'First month is January with Thai monthName');
    assert(typeof jan.approvedDays === 'number', 'Month item has numeric approvedDays');
    assert(typeof jan.approvedCount === 'number', 'Month item has numeric approvedCount');
    assert(typeof jan.pendingCount === 'number', 'Month item has numeric pendingCount');

    // 5. Test Leave Types Breakdown
    console.log('\n5️⃣  Testing Leave Types Breakdown...');
    assert(res.json.byType && typeof res.json.byType === 'object', 'byType is an object');
    const requiredTypes = ['Vacation', 'Personal', 'Sick', 'Unpaid'];
    requiredTypes.forEach(t => {
      assert(res.json.byType[t] !== undefined, `byType has category ${t}`);
      assert(typeof res.json.byType[t].days === 'number', `byType.${t}.days is a number`);
      assert(typeof res.json.byType[t].percentage === 'number', `byType.${t}.percentage is a number`);
    });

    // 6. Test Day of Week Distribution
    console.log('\n6️⃣  Testing Day of Week Frequency...');
    assert(Array.isArray(res.json.byDayOfWeek), 'byDayOfWeek is an array');
    assert(res.json.byDayOfWeek.length === 7, 'byDayOfWeek has 7 days');
    const dayItem = res.json.byDayOfWeek[0];
    assert(typeof dayItem.dayName === 'string', 'dayItem has dayName');
    assert(typeof dayItem.days === 'number', 'dayItem has numeric days');

    // 7. Test Department & Shift Breakdowns
    console.log('\n7️⃣  Testing Department & Shift Breakdown...');
    assert(Array.isArray(res.json.byDepartment), 'byDepartment is an array');
    assert(Array.isArray(res.json.byShift), 'byShift is an array');

    // 8. Test Query Filters (Department & Shift filtering)
    console.log('\n8️⃣  Testing Filters (Department = Assembly, Shift = A)...');
    const filteredRes = await makeRequest(`/api/analytics/summary?year=${currentYear}&department=Assembly&shift=A`);
    assert(filteredRes.status === 200, 'GET /api/analytics/summary with filters returns 200');
    assert(filteredRes.json.department === 'Assembly', 'Response reflects requested department filter');
    assert(filteredRes.json.shift === 'A', 'Response reflects requested shift filter');
    assert(typeof filteredRes.json.summary.totalApprovedDays === 'number', 'Filtered summary has totalApprovedDays');

    // Summary
    console.log(`\n========================================`);
    console.log(`📊 Analytics Test Results: ${passed}/${total} assertions passed.`);
    console.log(`========================================\n`);

    if (passed === total) {
      console.log('🎉 All Leave Analytics & Visual Charts tests passed perfectly!\n');
    }
  } catch (err) {
    console.error('Fatal test error:', err);
    process.exitCode = 1;
  } finally {
    if (server) {
      server.close();
    }
    process.exit(process.exitCode || 0);
  }
}

runTests();
