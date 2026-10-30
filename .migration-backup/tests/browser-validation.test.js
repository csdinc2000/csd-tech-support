import http from 'http';
import { URL } from 'url';

const baseUrl = process.env.TEST_BASE_URL || 'http://localhost:5001';

function makeRequest(path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'RMM-Test/1.0'
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      
      res.on('data', (chunk) => {
        body += chunk;
      });
      
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: body
        });
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.end();
  });
}

async function validatePageLoad(route, expectedElements = []) {
  try {
    console.log(`📄 Testing route: ${route}`);
    const result = await makeRequest(route);
    
    if (result.status !== 200) {
      console.log(`  ❌ HTTP ${result.status} - Page not accessible`);
      return false;
    }

    // Basic HTML structure validation
    const html = result.body;
    const hasDoctype = html.includes('<!DOCTYPE html>');
    const hasHtml = html.includes('<html');
    const hasHead = html.includes('<head>');
    const hasBody = html.includes('<body>');
    const hasReactRoot = html.includes('id="root"');

    if (!hasDoctype || !hasHtml || !hasHead || !hasBody || !hasReactRoot) {
      console.log(`  ❌ Missing essential HTML structure`);
      return false;
    }

    // Check for JavaScript errors in the HTML
    if (html.includes('error') && html.includes('javascript')) {
      console.log(`  ⚠️  Potential JavaScript errors detected`);
    }

    // Check for expected elements (basic string matching)
    let missingElements = [];
    for (const element of expectedElements) {
      if (!html.includes(element)) {
        missingElements.push(element);
      }
    }

    if (missingElements.length > 0) {
      console.log(`  ⚠️  Missing expected elements: ${missingElements.join(', ')}`);
    }

    console.log(`  ✅ Page structure valid`);
    return true;
    
  } catch (error) {
    console.log(`  ❌ Request failed: ${error.message}`);
    return false;
  }
}

async function runBrowserValidationTests() {
  console.log('🌐 Starting Browser Validation Tests...\n');
  
  const routes = [
    { path: '/', name: 'Root (redirects to dashboard)' },
    { path: '/dashboard', name: 'Dashboard', expected: ['RMM Platform', 'System Status'] },
    { path: '/devices', name: 'Device Management', expected: ['Device'] },
    { path: '/remote-access', name: 'Remote Access', expected: ['Remote'] },
    { path: '/monitoring', name: 'Real-time Monitoring', expected: ['Monitor'] },
    { path: '/tickets', name: 'Help Desk', expected: ['Ticket'] },
    { path: '/automation', name: 'Automation Hub', expected: ['Automation'] },
    { path: '/reports', name: 'Reports & Analytics', expected: ['Reports'] },
    { path: '/clients', name: 'Client Management', expected: ['Client'] }
  ];

  let passed = 0;
  let failed = 0;

  for (const route of routes) {
    const success = await validatePageLoad(route.path, route.expected || []);
    if (success) {
      passed++;
    } else {
      failed++;
    }
    console.log(''); // Empty line for readability
  }

  console.log('📊 Browser Validation Results:');
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📈 Success Rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);

  return { passed, failed };
}

// Run validation tests
runBrowserValidationTests()
  .then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  })
  .catch(error => {
    console.error('Browser validation failed:', error);
    process.exit(1);
  });

export { validatePageLoad, runBrowserValidationTests };