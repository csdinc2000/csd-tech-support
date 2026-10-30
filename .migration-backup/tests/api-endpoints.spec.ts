import { test, expect } from '@playwright/test';

test.describe('API Endpoints Tests', () => {
  
  test('Dashboard metrics endpoint returns valid data', async ({ request }) => {
    const response = await request.get('/api/dashboard/metrics');
    expect(response.ok()).toBeTruthy();
    
    const data = await response.json();
    expect(data).toHaveProperty('totalDevices');
    expect(data).toHaveProperty('activeAlerts');
    expect(data).toHaveProperty('openTickets');
    expect(data).toHaveProperty('avgResponseTime');
    expect(typeof data.totalDevices).toBe('number');
    expect(typeof data.activeAlerts).toBe('number');
  });

  test('Devices endpoint returns device list', async ({ request }) => {
    const response = await request.get('/api/devices');
    expect(response.ok()).toBeTruthy();
    
    const devices = await response.json();
    expect(Array.isArray(devices)).toBeTruthy();
    if (devices.length > 0) {
      expect(devices[0]).toHaveProperty('id');
      expect(devices[0]).toHaveProperty('name');
      expect(devices[0]).toHaveProperty('type');
      expect(devices[0]).toHaveProperty('status');
    }
  });

  test('Active alerts endpoint returns alerts', async ({ request }) => {
    const response = await request.get('/api/alerts/active');
    expect(response.ok()).toBeTruthy();
    
    const alerts = await response.json();
    expect(Array.isArray(alerts)).toBeTruthy();
    if (alerts.length > 0) {
      expect(alerts[0]).toHaveProperty('id');
      expect(alerts[0]).toHaveProperty('title');
      expect(alerts[0]).toHaveProperty('severity');
    }
  });

  test('Tickets endpoint returns ticket list', async ({ request }) => {
    const response = await request.get('/api/tickets/open');
    expect(response.ok()).toBeTruthy();
    
    const tickets = await response.json();
    expect(Array.isArray(tickets)).toBeTruthy();
    if (tickets.length > 0) {
      expect(tickets[0]).toHaveProperty('id');
      expect(tickets[0]).toHaveProperty('subject');
      expect(tickets[0]).toHaveProperty('priority');
      expect(tickets[0]).toHaveProperty('status');
    }
  });

  test('Clients endpoint returns client list', async ({ request }) => {
    const response = await request.get('/api/clients');
    expect(response.ok()).toBeTruthy();
    
    const clients = await response.json();
    expect(Array.isArray(clients)).toBeTruthy();
    if (clients.length > 0) {
      expect(clients[0]).toHaveProperty('id');
      expect(clients[0]).toHaveProperty('name');
    }
  });

  test('Patches endpoint returns patch list', async ({ request }) => {
    const response = await request.get('/api/patches');
    expect(response.ok()).toBeTruthy();
    
    const patches = await response.json();
    expect(Array.isArray(patches)).toBeTruthy();
    if (patches.length > 0) {
      expect(patches[0]).toHaveProperty('id');
      expect(patches[0]).toHaveProperty('title');
      expect(patches[0]).toHaveProperty('severity');
    }
  });

  test('Automation scripts endpoint returns scripts', async ({ request }) => {
    const response = await request.get('/api/automation-scripts');
    expect(response.ok()).toBeTruthy();
    
    const scripts = await response.json();
    expect(Array.isArray(scripts)).toBeTruthy();
    if (scripts.length > 0) {
      expect(scripts[0]).toHaveProperty('id');
      expect(scripts[0]).toHaveProperty('name');
      expect(scripts[0]).toHaveProperty('type');
    }
  });

  test('Network devices endpoint returns network devices', async ({ request }) => {
    const response = await request.get('/api/network/devices');
    expect(response.ok()).toBeTruthy();
    
    const devices = await response.json();
    expect(Array.isArray(devices)).toBeTruthy();
    if (devices.length > 0) {
      expect(devices[0]).toHaveProperty('ipAddress');
      expect(devices[0]).toHaveProperty('macAddress');
      expect(devices[0]).toHaveProperty('hostname');
      expect(devices[0]).toHaveProperty('deviceType');
      expect(devices[0]).toHaveProperty('status');
    }
  });

  test('Network scan history endpoint returns scan history', async ({ request }) => {
    const response = await request.get('/api/network/scans/history');
    expect(response.ok()).toBeTruthy();
    
    const scans = await response.json();
    expect(Array.isArray(scans)).toBeTruthy();
    if (scans.length > 0) {
      expect(scans[0]).toHaveProperty('networkRange');
      expect(scans[0]).toHaveProperty('status');
      expect(scans[0]).toHaveProperty('devicesFound');
    }
  });

  test('Remote access sessions endpoint returns sessions', async ({ request }) => {
    const response = await request.get('/api/remote-sessions/active');
    expect(response.ok()).toBeTruthy();
    
    const sessions = await response.json();
    expect(Array.isArray(sessions)).toBeTruthy();
  });

  test('Patch policies endpoint returns policies', async ({ request }) => {
    const response = await request.get('/api/patch-policies');
    expect(response.ok()).toBeTruthy();
    
    const policies = await response.json();
    expect(Array.isArray(policies)).toBeTruthy();
    if (policies.length > 0) {
      expect(policies[0]).toHaveProperty('id');
      expect(policies[0]).toHaveProperty('name');
      expect(policies[0]).toHaveProperty('autoInstall');
    }
  });

});