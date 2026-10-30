import { test, expect } from '@playwright/test';

test.describe('API Endpoints', () => {
  test('should fetch dashboard metrics', async ({ request }) => {
    const response = await request.get('/api/dashboard/metrics');
    expect(response.status()).toBe(200);
    
    const data = await response.json();
    expect(data).toHaveProperty('totalDevices');
    expect(data).toHaveProperty('activeAlerts');
    expect(data).toHaveProperty('openTickets');
    expect(data).toHaveProperty('uptime');
  });

  test('should fetch devices list', async ({ request }) => {
    const response = await request.get('/api/devices');
    expect(response.status()).toBe(200);
    
    const data = await response.json();
    expect(Array.isArray(data)).toBeTruthy();
  });

  test('should fetch active alerts', async ({ request }) => {
    const response = await request.get('/api/alerts/active');
    expect(response.status()).toBe(200);
    
    const data = await response.json();
    expect(Array.isArray(data)).toBeTruthy();
  });

  test('should fetch open tickets', async ({ request }) => {
    const response = await request.get('/api/tickets/open');
    expect(response.status()).toBe(200);
    
    const data = await response.json();
    expect(Array.isArray(data)).toBeTruthy();
  });

  test('should fetch automation scripts', async ({ request }) => {
    const response = await request.get('/api/automation-scripts');
    expect(response.status()).toBe(200);
    
    const data = await response.json();
    expect(Array.isArray(data)).toBeTruthy();
  });

  test('should fetch real-time monitoring data', async ({ request }) => {
    const response = await request.get('/api/monitoring/realtime');
    expect(response.status()).toBe(200);
    
    const data = await response.json();
    expect(Array.isArray(data)).toBeTruthy();
  });

  test('should fetch patch management data', async ({ request }) => {
    const response = await request.get('/api/patches');
    expect(response.status()).toBe(200);
    
    const data = await response.json();
    expect(Array.isArray(data)).toBeTruthy();
  });

  test('should fetch remote access sessions', async ({ request }) => {
    const response = await request.get('/api/remote-sessions/active');
    expect(response.status()).toBe(200);
    
    const data = await response.json();
    expect(Array.isArray(data)).toBeTruthy();
  });

  test('should fetch clients list', async ({ request }) => {
    const response = await request.get('/api/clients');
    expect(response.status()).toBe(200);
    
    const data = await response.json();
    expect(Array.isArray(data)).toBeTruthy();
  });

  test('should handle MeshCentral status', async ({ request }) => {
    const response = await request.get('/api/meshcentral/status');
    expect(response.status()).toBe(200);
    
    const data = await response.json();
    expect(data).toHaveProperty('status');
  });
});