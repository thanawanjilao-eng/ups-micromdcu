/**
 * Daily UPS reminder emails.
 *
 * Every notification below is sent to the UNION of (deduped, only the ones
 * that are actually set):
 *   - the asset's "responsible_email" (asset-specific internal contact)
 *   - the asset's "contract_contact_email" (maintenance company contact)
 *   - the lab's "contact_email" (the lab's responsible staff, set on the
 *     "ผู้รับผิดชอบห้อง" page)
 *
 * BATTERY reminders escalate as the due date approaches, and keep repeating
 * until the battery is actually changed (which moves the due date forward,
 * resetting the schedule):
 *   - 90 days before due  → one reminder
 *   - 60 days before due  → one reminder
 *   - 30 days before due  → reminder, then every 7 days
 *   - 7 days before due   → reminder, then every day (including if overdue)
 *   until last_battery_date is updated (next_battery_date changes).
 *
 * MA reminders stay as a single reminder within 7 days of the due date
 * (unchanged cadence — only battery was asked to escalate).
 *
 * URGENT REPAIR TICKETS ("แจ้งซ่อมด่วน") that are still open
 * (status === 'รอดำเนินการ') get a reminder email every day until someone
 * marks the ticket as resolved in the app.
 *
 * Run manually:  FIREBASE_SERVICE_ACCOUNT='<json>' GMAIL_USER=... GMAIL_APP_PASSWORD=... node scripts/send-reminders.js
 * Run on a schedule: see .github/workflows/daily-reminders.yml
 */
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

function requireEnv(name){
  const v = process.env[name];
  if(!v){ console.error(`Missing required environment variable: ${name}`); process.exit(1); }
  return v;
}

const serviceAccountRaw = requireEnv('FIREBASE_SERVICE_ACCOUNT');
const GMAIL_USER = requireEnv('GMAIL_USER');
const GMAIL_APP_PASSWORD = requireEnv('GMAIL_APP_PASSWORD');

const serviceAccount = JSON.parse(serviceAccountRaw);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD }
});

function daysUntil(dateStr){
  if(!dateStr) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  const d = new Date(dateStr); d.setHours(0,0,0,0);
  return Math.round((d - today) / 86400000);
}
function daysSince(isoDateTime){
  if(!isoDateTime) return Infinity;
  const ms = Date.now() - new Date(isoDateTime).getTime();
  return ms / 86400000;
}
function addYearsISO(dateStr, n){
  if(!dateStr) return null;
  const d = new Date(dateStr);
  d.setFullYear(d.getFullYear() + n);
  return d.toISOString().slice(0, 10);
}
function addMonthsISO(dateStr, n){
  if(!dateStr) return null;
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() + n);
  return d.toISOString().slice(0, 10);
}
function nextBatteryDue(a){
  return a.next_battery_date || addYearsISO(a.last_battery_date, 2);
}
function nextMaDue(a){
  return a.next_ma_date || addMonthsISO(a.last_ma_date, 4);
}
function fmtDateTH(d){
  if(!d) return '-';
  return new Date(d).toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' });
}
function getRecipients(asset, lab){
  const list = [lab && lab.contact_email, asset.responsible_email, asset.contract_contact_email].filter(Boolean);
  return [...new Set(list.map(e => e.trim()).filter(Boolean))];
}

/** Required gap (in days) between battery reminders, given how many days
 *  are left until the battery is due. Returns null if it's too early
 *  (more than 90 days out) to remind at all. */
function batteryCadenceDays(daysLeft){
  if(daysLeft > 90) return null;
  if(daysLeft > 60) return 30;  // ~90-day checkpoint, next one ~60 days out
  if(daysLeft > 30) return 30;  // ~60-day checkpoint, next one ~30 days out
  if(daysLeft > 7) return 7;    // inside 1 month: weekly
  return 1;                      // inside 1 week (and overdue): daily
}

async function sendMail({ to, subject, html }){
  await transporter.sendMail({ from: `"ระบบแจ้งเตือน UPS" <${GMAIL_USER}>`, to: to.join(','), subject, html });
}

async function sendBatteryOrMaReminder({ asset, lab, type, dueDate, daysLeft, qrBaseUrl }){
  const verb = type === 'battery' ? 'เปลี่ยนแบตเตอรี่' : 'บำรุงรักษา MA (ทุก 4 เดือน)';
  const overdue = daysLeft < 0;
  const statusLine = overdue
    ? `เลยกำหนด${verb}มาแล้ว ${Math.abs(daysLeft)} วัน`
    : `ใกล้ครบกำหนด${verb}ใน ${daysLeft} วัน`;

  const recipients = getRecipients(asset, lab);
  if(recipients.length === 0){
    console.log(`Skip ${asset.asset_id} (${type}) — no recipient email set`);
    return false;
  }

  const link = qrBaseUrl ? `${qrBaseUrl}#asset=${encodeURIComponent(asset.asset_id)}` : '';
  const html = `
    <p>เรียนผู้เกี่ยวข้อง</p>
    <p>ระบบแจ้งเตือน<b>${verb}</b>สำหรับเครื่อง UPS ดังนี้</p>
    <table cellpadding="6" style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
      <tr><td><b>Asset ID</b></td><td>${asset.asset_id}</td></tr>
      <tr><td><b>ห้องปฏิบัติการ</b></td><td>${(lab && lab.name) || asset.lab_id}</td></tr>
      <tr><td><b>ตำแหน่งติดตั้ง</b></td><td>${asset.location || '-'}</td></tr>
      <tr><td><b>กำหนด</b></td><td>${fmtDateTH(dueDate)}</td></tr>
      <tr><td><b>สถานะ</b></td><td>${statusLine}</td></tr>
    </table>
    ${link ? `<p><a href="${link}">เปิดหน้าเครื่องนี้ในระบบ</a></p>` : ''}
    <p>กรุณาดำเนินการและอัปเดตวันที่ในระบบทะเบียน UPS หลังดำเนินการเสร็จสิ้น${type === 'battery' ? ' — อีเมลนี้จะหยุดส่งเองทันทีที่มีการอัปเดตวันที่เปลี่ยนแบตใหม่' : ''}</p>
    <p style="color:#888;font-size:12px;">อีเมลนี้ส่งอัตโนมัติจากระบบบริหารจัดการ UPS — ไม่ต้องตอบกลับอีเมลนี้</p>
  `;
  await sendMail({ to: recipients, subject: `แจ้งเตือน${verb} — ${asset.asset_id} (${(lab && lab.name) || asset.lab_id})`, html });
  console.log(`Sent ${type} reminder for ${asset.asset_id} to ${recipients.join(', ')}`);
  return true;
}

async function sendTicketReminder({ ticket, asset, lab, qrBaseUrl }){
  const recipients = getRecipients(asset || {}, lab);
  if(recipients.length === 0){
    console.log(`Skip repair ticket for ${ticket.asset_id} — no recipient email set`);
    return false;
  }
  const link = qrBaseUrl ? `${qrBaseUrl}#asset=${encodeURIComponent(ticket.asset_id)}` : '';
  const daysOpen = Math.max(0, Math.round(daysSince(ticket.reported_at)));
  const html = `
    <p>เรียนผู้เกี่ยวข้อง</p>
    <p>🚨 มีรายการ<b>แจ้งซ่อมด่วน</b>ที่ยังไม่ได้รับการแก้ไข (ค้างมาแล้ว ${daysOpen} วัน)</p>
    <table cellpadding="6" style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
      <tr><td><b>Asset ID</b></td><td>${ticket.asset_id}</td></tr>
      <tr><td><b>ห้องปฏิบัติการ</b></td><td>${(lab && lab.name) || ticket.lab_id}</td></tr>
      <tr><td><b>ตำแหน่งติดตั้ง</b></td><td>${(asset && asset.location) || '-'}</td></tr>
      <tr><td><b>แจ้งโดย</b></td><td>${ticket.reporter_name || 'ไม่ระบุ'}</td></tr>
      <tr><td><b>อาการ/เหตุผล</b></td><td>${ticket.reason || '-'}</td></tr>
    </table>
    ${link ? `<p><a href="${link}">เปิดหน้าเครื่องนี้ในระบบ</a></p>` : ''}
    <p>กรุณาดำเนินการโดยเร็ว — ระบบจะส่งอีเมลแจ้งเตือนซ้ำทุกวันจนกว่าจะมีการทำเครื่องหมายว่า "เสร็จสิ้น" ในหน้า "แจ้งซ่อม"</p>
    <p style="color:#888;font-size:12px;">อีเมลนี้ส่งอัตโนมัติจากระบบบริหารจัดการ UPS — ไม่ต้องตอบกลับอีเมลนี้</p>
  `;
  await sendMail({ to: recipients, subject: `🚨 [ยังไม่ปิดงาน] แจ้งซ่อมด่วน — ${ticket.asset_id} (ค้าง ${daysOpen} วัน)`, html });
  console.log(`Sent repair-ticket reminder for ${ticket.asset_id} to ${recipients.join(', ')}`);
  return true;
}

async function main(){
  const settingsDoc = await db.collection('app_settings').doc('main').get();
  const qrBaseUrl = settingsDoc.exists ? (settingsDoc.data().qrBaseUrl || '') : '';

  const labsSnap = await db.collection('labs').get();
  const labMap = {};
  labsSnap.forEach(d => { labMap[d.id] = d.data(); });

  let sentCount = 0;

  // ---- Battery (escalating) + MA (single, within 7 days) ----
  const assetsSnap = await db.collection('assets').get();
  for(const doc of assetsSnap.docs){
    const a = doc.data();
    const ref = doc.ref;
    const lab = labMap[a.lab_id] || {};

    const batteryDue = nextBatteryDue(a);
    const batteryDays = daysUntil(batteryDue);
    if(batteryDays !== null){
      const cadence = batteryCadenceDays(batteryDays);
      if(cadence !== null){
        const cycleChanged = a.battery_reminder_due_snapshot !== batteryDue;
        const sinceLast = cycleChanged ? Infinity : daysSince(a.battery_reminder_last_sent);
        if(sinceLast >= cadence){
          const ok = await sendBatteryOrMaReminder({ asset: a, lab, type: 'battery', dueDate: batteryDue, daysLeft: batteryDays, qrBaseUrl });
          if(ok){
            await ref.update({ battery_reminder_last_sent: new Date().toISOString(), battery_reminder_due_snapshot: batteryDue });
            sentCount++;
          }
        }
      } else if(a.battery_reminder_due_snapshot !== batteryDue){
        await ref.update({ battery_reminder_due_snapshot: batteryDue, battery_reminder_last_sent: null });
      }
    }

    const maDue = nextMaDue(a);
    const maDays = daysUntil(maDue);
    if(maDays !== null && maDays <= 7 && a.ma_reminder_sent_for !== maDue){
      const ok = await sendBatteryOrMaReminder({ asset: a, lab, type: 'ma', dueDate: maDue, daysLeft: maDays, qrBaseUrl });
      if(ok){ await ref.update({ ma_reminder_sent_for: maDue }); sentCount++; }
    }
  }

  // ---- Open repair tickets ("แจ้งซ่อมด่วน") — daily until resolved ----
  const assetByAssetId = {};
  assetsSnap.forEach(d => { assetByAssetId[d.data().asset_id] = d.data(); });

  const ticketsSnap = await db.collection('repair_tickets').where('status', '==', 'รอดำเนินการ').get();
  for(const doc of ticketsSnap.docs){
    const t = doc.data();
    const ref = doc.ref;
    const lab = labMap[t.lab_id] || {};
    const asset = assetByAssetId[t.asset_id];
    const sinceLast = daysSince(t.last_reminder_sent || t.reported_at);
    if(sinceLast >= 1){
      const ok = await sendTicketReminder({ ticket: t, asset, lab, qrBaseUrl });
      if(ok){ await ref.update({ last_reminder_sent: new Date().toISOString() }); sentCount++; }
    }
  }

  console.log(`Done. Sent ${sentCount} reminder email(s). Checked ${assetsSnap.docs.length} asset(s) and ${ticketsSnap.docs.length} open repair ticket(s).`);
}

main().catch(err => { console.error(err); process.exit(1); });
