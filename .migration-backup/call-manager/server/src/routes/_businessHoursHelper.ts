import { getCurrentBusinessHoursState } from '../lib/businessHours.js';

export async function isOpenNow(): Promise<boolean> {
  try { return (await getCurrentBusinessHoursState()) === 'open'; } catch { return false; }
}
