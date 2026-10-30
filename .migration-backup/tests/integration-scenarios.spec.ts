import { test, expect } from '@playwright/test';

test.describe('Integration Scenarios', () => {

  test('Network scan workflow', async ({ page, request }) => {
    // Start a network scan via API
    const scanResponse = await request.post('/api/network/scans', {
      data: { networkRange: '192.168.1.0/24' }
    });
    expect(scanResponse.ok()).toBeTruthy();
    
    // Navigate to network discovery page
    await page.goto('/network-discovery');
    
    // Check that scan appears in active scans
    await expect(page.locator('h1')).toContainText('Network Discovery');
    
    // Check device discovery results
    const devicesResponse = await request.get('/api/network/devices');
    const devices = await devicesResponse.json();
    expect(devices.length).toBeGreaterThan(0);
  });

  test('Device monitoring and alerting workflow', async ({ page, request }) => {
    // Get devices
    const devicesResponse = await request.get('/api/devices');
    const devices = await devicesResponse.json();
    expect(devices.length).toBeGreaterThan(0);
    
    // Navigate to monitoring page
    await page.goto('/monitoring');
    await expect(page.locator('h1')).toContainText('Real-Time Monitoring');
    
    // Check alerts
    const alertsResponse = await request.get('/api/alerts/active');
    const alerts = await alertsResponse.json();
    expect(Array.isArray(alerts)).toBeTruthy();
  });

  test('Patch management workflow', async ({ page, request }) => {
    // Get available patches
    const patchesResponse = await request.get('/api/patches');
    const patches = await patchesResponse.json();
    expect(Array.isArray(patches)).toBeTruthy();
    
    // Get patch policies
    const policiesResponse = await request.get('/api/patch-policies');
    const policies = await policiesResponse.json();
    expect(Array.isArray(policies)).toBeTruthy();
    
    // Navigate to patch management
    await page.goto('/patches');
    await expect(page.locator('h1')).toContainText('Patch Management');
  });

  test('Helpdesk ticket management workflow', async ({ page, request }) => {
    // Get open tickets
    const ticketsResponse = await request.get('/api/tickets/open');
    const tickets = await ticketsResponse.json();
    expect(Array.isArray(tickets)).toBeTruthy();
    
    // Navigate to helpdesk
    await page.goto('/tickets');
    await expect(page.locator('h1')).toContainText('Help Desk');
    
    // Check for ticket creation button
    await expect(page.locator('button')).toContainText('New Ticket');
  });

  test('Dashboard data aggregation', async ({ page, request }) => {
    // Check that dashboard aggregates data from all services
    const metricsResponse = await request.get('/api/dashboard/metrics');
    const metrics = await metricsResponse.json();
    
    expect(metrics).toHaveProperty('totalDevices');
    expect(metrics).toHaveProperty('activeAlerts');
    expect(metrics).toHaveProperty('openTickets');
    
    // Navigate to dashboard and verify data display
    await page.goto('/');
    await expect(page.locator('h1')).toContainText('Dashboard');
  });

  test('Client management integration', async ({ page, request }) => {
    // Get clients
    const clientsResponse = await request.get('/api/clients');
    const clients = await clientsResponse.json();
    expect(Array.isArray(clients)).toBeTruthy();
    
    // Navigate to clients page
    await page.goto('/clients');
    await expect(page.locator('h1')).toContainText('Client Management');
  });

  test('Remote access session management', async ({ page, request }) => {
    // Check active sessions
    const sessionsResponse = await request.get('/api/remote-sessions/active');
    const sessions = await sessionsResponse.json();
    expect(Array.isArray(sessions)).toBeTruthy();
    
    // Navigate to remote access page
    await page.goto('/remote-access');
    await expect(page.locator('h1')).toContainText('Remote Access');
  });

  test('Automation script execution workflow', async ({ page, request }) => {
    // Get automation scripts
    const scriptsResponse = await request.get('/api/automation-scripts');
    const scripts = await scriptsResponse.json();
    expect(Array.isArray(scripts)).toBeTruthy();
    
    // Navigate to automation page
    await page.goto('/automation');
    await expect(page.locator('h1')).toContainText('Automation');
  });

});