import { test, expect } from '@playwright/test';

test.describe('Integration Tests', () => {
  test('should handle complete user workflow', async ({ page }) => {
    // Start at dashboard
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');
    
    await expect(page.locator('h1, h2').filter({ hasText: /RMM Platform|Dashboard/ })).toBeVisible();
    
    // Navigate to devices
    await page.click('text="Device Management"');
    await page.waitForLoadState('networkidle');
    
    // Check devices loaded
    await expect(page).toHaveURL(/.*\/devices/);
    
    // Navigate to monitoring
    if (await page.locator('text="Real-Time Monitoring"').count() > 0) {
      await page.click('text="Real-Time Monitoring"');
      await page.waitForLoadState('networkidle');
      await expect(page).toHaveURL(/.*\/monitoring/);
    }
    
    // Navigate to remote access
    await page.click('text="Remote Access"');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/.*\/remote-access/);
    
    // Navigate to tickets
    await page.click('text="Help Desk"');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/.*\/tickets/);
    
    // Return to dashboard
    await page.click('text="Dashboard"');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/.*\/dashboard/);
  });

  test('should handle data loading states', async ({ page }) => {
    await page.goto('/dashboard');
    
    // Check for loading states or data
    await page.waitForTimeout(3000);
    
    // Verify page is functional
    await expect(page.locator('body')).toBeVisible();
    await expect(page.locator('nav')).toBeVisible();
  });

  test('should handle error states gracefully', async ({ page }) => {
    // Test with potential network issues
    await page.route('/api/dashboard/metrics', route => {
      route.fulfill({ status: 500, body: '{"error": "Server error"}' });
    });
    
    await page.goto('/dashboard');
    await page.waitForTimeout(2000);
    
    // Page should still load even with API errors
    await expect(page.locator('body')).toBeVisible();
  });

  test('should maintain state across navigation', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');
    
    // Navigate away and back
    await page.click('text="Device Management"');
    await page.waitForLoadState('networkidle');
    
    await page.click('text="Dashboard"');
    await page.waitForLoadState('networkidle');
    
    // Should still be functional
    await expect(page.locator('h1, h2').filter({ hasText: /RMM Platform|Dashboard/ })).toBeVisible();
  });

  test('should handle concurrent operations', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');
    
    // Open multiple sections rapidly
    const promises = [
      page.click('text="Device Management"'),
      page.waitForTimeout(100),
      page.click('text="Help Desk"'),
      page.waitForTimeout(100),
      page.click('text="Dashboard"'),
    ];
    
    await Promise.all(promises);
    
    // Should end up somewhere valid
    await expect(page.locator('body')).toBeVisible();
  });
});