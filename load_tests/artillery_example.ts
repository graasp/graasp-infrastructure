import { type Config, type Scenario } from 'artillery';

export const config: Config = {
  target: 'https://graasp.org',
  phases: [
    // Warm-up: find baseline performance without stressing the system.
    { duration: 2 * 60, arrivalRate: 10, name: 'warm-up' },
    // Ramp: gradually increase load to observe how performance degrades.
    { duration: 5 * 60, arrivalRate: 25, rampTo: 150, name: 'ramp' },
    // Steady: hold at a target concurrency to measure stability.
    { duration: 10 * 60, arrivalRate: 150, name: 'steady' },
    // Spike: short burst to test autoscaling and headroom.
    { duration: 3 * 60, arrivalRate: 300, name: 'spike' },
    // Recovery: drop to moderate load to see if metrics recover.
    { duration: 5 * 60, arrivalRate: 75, name: 'recovery' },
    // Soak: extended moderate load for memory leaks or long-tail failures.
    { duration: 15 * 60, arrivalRate: 100, name: 'soak' },
  ],

  engines: {
    playwright: {},
  },
};

export const scenarios: Scenario[] = [
  {
    engine: 'playwright',
    testFunction: libraryFlow,
  },
];

async function helloWorld(page) {
  await page.goto('https://graasp.org/');
  await page.click('text=Register');
}

async function libraryFlow(page) {
  await page.goto('https://graasp.org/');
  await page.getByRole('link', { name: 'Library', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search resources…' }).click();
  await page
    .getByRole('textbox', { name: 'Search resources…' })
    .fill('geogebra');
  await page
    .getByRole('link', { name: 'Geogebra Geogebra Interactive' })
    .first()
    .click();
  const page1Promise = page.waitForEvent('popup');
  await page.getByRole('link', { name: 'Preview' }).click();
  const page1 = await page1Promise;
  await page1.locator('a').filter({ hasText: 'Graasp' }).click();
  await page1.getByTestId('library').click();
  await page1.getByRole('textbox', { name: 'Search resources…' }).click();
  await page1
    .getByRole('textbox', { name: 'Search resources…' })
    .fill('basile');
  await page1.getByRole('link', { name: 'See 801 more results' }).click();
  await page1.locator('a').filter({ hasText: 'Demo chatbots' }).click();
  const page2Promise = page1.waitForEvent('popup');
  await page1.getByRole('link', { name: 'Preview' }).click();
  const page2 = await page2Promise;
}
