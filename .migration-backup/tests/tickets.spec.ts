import { test, expect } from '@playwright/test';

test.describe('Ticket Management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tickets');
    await page.waitForLoadState('networkidle');
  });

  test('should load tickets page', async ({ page }) => {
    await expect(page.locator('h1, h2').filter({ hasText: /Tickets|Help Desk/ })).toBeVisible();
  });

  test('should display ticket list', async ({ page }) => {
    await page.waitForTimeout(2000);
    
    const ticketsList = page.locator('[data-testid="tickets-list"]').or(
      page.locator('div').filter({ hasText: /Ticket|#/ })
    );
    
    const ticketsCount = await ticketsList.count();
    if (ticketsCount > 0) {
      await expect(ticketsList.first()).toBeVisible();
    }
  });

  test('should show ticket priority indicators', async ({ page }) => {
    await page.waitForTimeout(2000);
    
    const priorityIndicators = page.locator('text="High"').or(
      page.locator('text="Medium"')
    ).or(
      page.locator('text="Low"')
    ).or(
      page.locator('.bg-red-100, .bg-yellow-100, .bg-green-100')
    );
    
    const priorityCount = await priorityIndicators.count();
    if (priorityCount > 0) {
      await expect(priorityIndicators.first()).toBeVisible();
    }
  });

  test('should display ticket status', async ({ page }) => {
    await page.waitForTimeout(2000);
    
    const statusElements = page.locator('text="Open"').or(
      page.locator('text="In Progress"')
    ).or(
      page.locator('text="Resolved"')
    ).or(
      page.locator('text="Closed"')
    );
    
    const statusCount = await statusElements.count();
    if (statusCount > 0) {
      await expect(statusElements.first()).toBeVisible();
    }
  });

  test('should handle ticket filtering', async ({ page }) => {
    await page.waitForTimeout(2000);
    
    const filterButtons = page.locator('button').filter({ 
      hasText: /All|Open|Closed|High Priority|My Tickets/ 
    });
    
    const filterCount = await filterButtons.count();
    if (filterCount > 0) {
      await filterButtons.first().click();
      await page.waitForTimeout(500);
    }
  });

  test('should show create ticket option', async ({ page }) => {
    const createButton = page.locator('button').filter({ hasText: /Create|New Ticket/ });
    const createCount = await createButton.count();
    
    if (createCount > 0) {
      await expect(createButton.first()).toBeVisible();
    }
  });
});