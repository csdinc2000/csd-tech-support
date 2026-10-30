import { test, expect } from '@playwright/test';

test.describe('Frontend Pages Tests', () => {

  test('Dashboard page loads correctly', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/RMM Platform/);
    
    // Check for key dashboard elements
    await expect(page.locator('h1')).toContainText('Dashboard');
    await expect(page.locator('[data-testid="total-devices"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="active-alerts"]').first()).toBeVisible();
  });

  test('Device Management page loads', async ({ page }) => {
    await page.goto('/devices');
    await expect(page.locator('h1')).toContainText('Device Management');
    
    // Check for device list elements
    await expect(page.locator('table').first()).toBeVisible();
  });

  test('Network Discovery page loads', async ({ page }) => {
    await page.goto('/network-discovery');
    await expect(page.locator('h1')).toContainText('Network Discovery');
    
    // Check for network discovery elements
    await expect(page.locator('button')).toContainText('Start Network Scan');
  });

  test('Monitoring page loads', async ({ page }) => {
    await page.goto('/monitoring');
    await expect(page.locator('h1')).toContainText('Real-Time Monitoring');
  });

  test('Patch Management page loads', async ({ page }) => {
    await page.goto('/patches');
    await expect(page.locator('h1')).toContainText('Patch Management');
  });

  test('Tickets page loads', async ({ page }) => {
    await page.goto('/tickets');
    await expect(page.locator('h1')).toContainText('Help Desk');
  });

  test('Remote Access page loads', async ({ page }) => {
    await page.goto('/remote-access');
    await expect(page.locator('h1')).toContainText('Remote Access');
  });

  test('Automation page loads', async ({ page }) => {
    await page.goto('/automation');
    await expect(page.locator('h1')).toContainText('Automation');
  });

  test('Reports page loads', async ({ page }) => {
    await page.goto('/reports');
    await expect(page.locator('h1')).toContainText('Reports & Analytics');
  });

  test('Clients page loads', async ({ page }) => {
    await page.goto('/clients');
    await expect(page.locator('h1')).toContainText('Client Management');
  });

  test('Navigation sidebar works', async ({ page }) => {
    await page.goto('/');
    
    // Test navigation links
    await page.click('a[href="/devices"]');
    await expect(page.locator('h1')).toContainText('Device Management');
    
    await page.click('a[href="/network-discovery"]');
    await expect(page.locator('h1')).toContainText('Network Discovery');
    
    await page.click('a[href="/monitoring"]');
    await expect(page.locator('h1')).toContainText('Real-Time Monitoring');
  });

  test('Mobile responsive design works', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 }); // iPhone size
    await page.goto('/');
    
    // Check that mobile elements are visible
    await expect(page.locator('h1')).toContainText('Dashboard');
    
    // Test that the page is responsive (content doesn't overflow)
    const body = await page.locator('body').boundingBox();
    expect(body?.width).toBeLessThanOrEqual(375);
  });

  test('Error page handles invalid routes', async ({ page }) => {
    await page.goto('/invalid-route');
    await expect(page.locator('h1')).toContainText('404');
  });

});