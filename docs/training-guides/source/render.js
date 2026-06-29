const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const docs = [
    ['customer-guide.html','Luna-Chat-User-Guide.pdf'],
    ['staff-guide.html','Luna-Chat-Staff-Guide.pdf'],
  ];
  for (const [src,out] of docs){
    const page = await b.newPage();
    await page.goto('file://'+path.resolve(src), { waitUntil:'networkidle' });
    await page.emulateMedia({ media:'print' });
    await page.waitForTimeout(500);
    await page.pdf({ path: out, format:'A4', printBackground:true, preferCSSPageSize:true });
    console.log('rendered', out);
    await page.close();
  }
  await b.close();
})();
