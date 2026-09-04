/**
 * Daily UPS reminder emails.
 *
 * Reads every asset from Firestore and, once per due-date cycle, emails:
 *   - the asset's "responsible_email" (internal lab contact), and
 *   - the asset's "contract_contact_email" (maintenance company contact), if set
 * when:
 *   - battery change is due within 30 days ("battery_reminder_sent_for" tracks
 *     the due date it was already sent for, so it won't resend until the due
 *     date itself changes — e.g. after the battery is actually replaced)
 *   - MA (annual maintenance) is due within 7 days (same dedup approach via
 *     "ma_reminder_sent_for")
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
function addYearsISO(dateStr, n){
  if(!dateStr) return null;
  const d = new Date(dateStr);
  d.setFullYear(d.getFullYear() + n);
  return d.toISOString().slice(0, 10);
}
function nextBatteryDue(a){
  return a.next_battery_date || addYearsISO(a.last_battery_date, 2);
}
function fmtDateTH(d){
  if(!d) return '-';
  return new Date(d).toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' });
}

async function sendReminder({ asset, lab, type, dueDate, daysLeft, qrBaseUrl }){
  const verb = type === 'battery' ? 'เปลี่ยนแบตเตอรี่' : 'บำรุงรักษาประจำปี (MA)';
  const overdue = daysLeft < 0;
  const statusLine = overdue
    ? `เลยกำหนด${verb}มาแล้ว ${Math.abs(daysLeft)} วัน`
    : `ใกล้ครบกำหนด${verb}ใน ${daysLeft} วัน`;

  const recipients = [asset.responsible_email, asset.contract_contact_email].filter(Boolean);
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
    <p>กรุณาดำเนินการและอัปเดตวันที่ในระบบทะเบียน UPS หลังดำเนินการเสร็จสิ้น</p>
    <p style="color:#888;font-size:12px;">อีเมลนี้ส่งอัตโนมัติทุกวันจากระบบบริหารจัดการ UPS — ไม่ต้องตอบกลับอีเมลนี้</p>
  `;

  await transporter.sendMail({
    from: `"ระบบแจ้งเตือน UPS" <${GMAIL_USER}>`,
    to: recipients.join(','),
    subject: `แจ้งเตือน${verb} — ${asset.asset_id} (${(lab && lab.name) || asset.lab_id})`,
    html
  });
  console.log(`Sent ${type} reminder for ${asset.asset_id} to ${recipients.join(', ')}`);
  return true;
}

async function main(){
  const settingsDoc = await db.collection('app_settings').doc('main').get();
  const qrBaseUrl = settingsDoc.exists ? (settingsDoc.data().qrBaseUrl || '') : '';

  const labsSnap = await db.collection('labs').get();
  const labMap = {};
  labsSnap.forEach(d => { labMap[d.id] = d.data(); });

  const assetsSnap = await db.collection('assets').get();
  let sentCount = 0;

  for(const doc of assetsSnap.docs){
    const a = doc.data();
    const ref = doc.ref;
    const lab = labMap[a.lab_id] || {};

    const batteryDue = nextBatteryDue(a);
    const batteryDays = daysUntil(batteryDue);
    if(batteryDays !== null && batteryDays <= 30 && a.battery_reminder_sent_for !== batteryDue){
      const ok = await sendReminder({ asset: a, lab, type: 'battery', dueDate: batteryDue, daysLeft: batteryDays, qrBaseUrl });
      if(ok){ await ref.update({ battery_reminder_sent_for: batteryDue }); sentCount++; }
    }

    const maDue = a.next_ma_date;
    const maDays = daysUntil(maDue);
    if(maDays !== null && maDays <= 7 && a.ma_reminder_sent_for !== maDue){
      const ok = await sendReminder({ asset: a, lab, type: 'ma', dueDate: maDue, daysLeft: maDays, qrBaseUrl });
      if(ok){ await ref.update({ ma_reminder_sent_for: maDue }); sentCount++; }
    }
  }

  console.log(`Done. Sent ${sentCount} reminder email(s) out of ${assetsSnap.docs.length} asset(s) checked.`);
}

main().catch(err => { console.error(err); process.exit(1); });
