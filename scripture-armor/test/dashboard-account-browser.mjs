import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createArmorDashboard } from '../dashboard.mjs';
const require=createRequire(import.meta.url);const {chromium}=require(process.env.ARMOR_TEST_BROWSER_MODULE || 'playwright');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'armor-account-browser-'));const now=Math.floor(Date.now()/1000);const email='member@example.test';
const json=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json',...headers}});
const server=createArmorDashboard({sessionStore:null,identityDir:path.join(temp,'identity'),fetchImpl:async(url,options)=>{
 assert.equal(new URL(url).origin,'https://www.ronininc.org');
 const action=new URL(url).pathname.split('/').pop();
 if(action==='login')return json({ok:true,emailCodeRequired:true,challengeId:'synthetic',purpose:'login',email,expiresAt:now+300},202);
 if(action==='verify')return JSON.parse(options.body).code==='12345678'?json({ok:true,mfaVerified:true,member:{email}},200,{'set-cookie':`ronin_armor=${'c'.repeat(64)};HttpOnly;Secure;Path=/;SameSite=Strict`}):json({ok:false},403);
 if(action==='me')return json({ok:true,mfaVerified:true,member:{email,mfa_verified_at:now,paid:false}});
 if(action==='logout')return json({ok:true});
 throw new Error('No other remote operation is permitted in this proof');
}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
try{
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1320,height:1000}});
 await page.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
 await page.goto(origin);if(process.env.ARMOR_UI_PROOF_SCREENSHOT)await page.screenshot({path:process.env.ARMOR_UI_PROOF_SCREENSHOT.replace(/\.png$/, '-login.png'),fullPage:true});
 const modifier=process.platform==='darwin'?'Meta':'Control';const name=page.locator('#accountName');await name.fill('CROSS-PLATFORM-COPY-PASTE');await name.press(`${modifier}+A`);await name.press(`${modifier}+C`);await name.fill('');await name.press(`${modifier}+V`);assert.equal(await name.inputValue(),'CROSS-PLATFORM-COPY-PASTE');await name.fill('');
 await page.locator('#accountEmail').fill(email);await page.locator('#accountPassword').fill('synthetic-only-password');await page.locator('#accountLogin').click();
 await page.locator('#codePanel').waitFor({state:'visible'});assert.equal(await page.locator('#accountPassword').inputValue(),'');assert.equal(await page.locator('#installer').isVisible(),false);
 await page.locator('#emailOtp').fill('00000000');await page.locator('#accountVerify').click();await page.waitForFunction(()=>document.querySelector('#authNotice').textContent.includes('failed'));assert.equal(await page.locator('#emailOtp').inputValue(),'');assert.equal(await page.locator('#installer').isVisible(),false);
 await page.locator('#emailOtp').fill('12345678');await page.locator('#accountVerify').click();await page.locator('#installer').waitFor({state:'visible'});assert.equal(await page.locator('#app').isVisible(),false);assert.equal(fs.existsSync(path.join(temp,'identity')),false);
 const out=process.env.ARMOR_UI_PROOF_SCREENSHOT; if(out) await page.screenshot({path:out,fullPage:true});
 await page.locator('#accountLogout').click();await page.locator('#accountPanel').waitFor({state:'visible'});assert.equal(await page.locator('#installer').isVisible(),false);
 console.log('PASS real Chromium local UI: OS copy/paste works; password cleared; pending/wrong OTP locked; valid OTP shows entitlement-gated installer; no identity or migration; logout locks. Screenshot: '+out);
}finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}
