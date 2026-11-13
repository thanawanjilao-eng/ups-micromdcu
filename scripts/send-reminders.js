/**
 * Daily UPS reminder emails (run by GitHub Actions — see daily-reminders.yml).
 *
 * Recipients of every email = the UNION of (deduped, only the ones that are set):
 *   - the lab's "contact_email"        (page "ผู้รับผิดชอบห้อง")
 *   - the asset's "responsible_email"  (edit form, section ผู้รับผิดชอบ)
 *   - the asset's "contract_contact_email" (edit form, section สัญญาบำรุงรักษา)
 *
 * BATTERY: 90d → 60d (one each), then weekly from 30d, then daily from 7d
 *          (and while overdue) until the battery date is updated.
 * MA:      one reminder when due within 7 days. NOTE: MA reminders only exist
 *          for machines that have "วันที่ทำ MA ล่าสุด" or "กำหนด MA ครั้งต่อไป" filled in.
 * REPAIR TICKETS: every day while status is "รอดำเนินการ".
 *
 * Every run prints a per-machine report explaining WHY an email was or wasn't sent.
 *
 * Manual test: Actions → Run workflow → type an address in "test_email" to send
 * a single test mail (verifies the Gmail login) without touching any data.
 */
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

function requireEnv(name){
  const v = process.env[name];
  if(!v){ console.error(`Missing required environment variable: ${name}`); process.exit(1); }
  return v;
}
const serviceAccount = JSON.parse(requireEnv('FIREBASE_SERVICE_ACCOUNT'));
const GMAIL_USER = requireEnv('GMAIL_USER');
const GMAIL_APP_PASSWORD = requireEnv('GMAIL_APP_PASSWORD');
const TEST_EMAIL = (process.env.TEST_EMAIL || '').trim();

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD } });

function daysUntil(dateStr){
  if(!dateStr) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  const d = new Date(dateStr); d.setHours(0,0,0,0);
  return Math.round((d - today) / 86400000);
}
function daysSince(iso){ return iso ? (Date.now() - new Date(iso).getTime()) / 86400000 : Infinity; }
function addYearsISO(s, n){ if(!s) return null; const d = new Date(s); d.setFullYear(d.getFullYear() + n); return d.toISOString().slice(0, 10); }
function addMonthsISO(s, n){ if(!s) return null; const d = new Date(s); d.setMonth(d.getMonth() + n); return d.toISOString().slice(0, 10); }
function nextBatteryDue(a){ return a.next_battery_date || addYearsISO(a.last_battery_date, 2); }
function nextMaDue(a){ return a.next_ma_date || addMonthsISO(a.last_ma_date, 4); }
function fmtDateTH(d){ return d ? new Date(d).toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' }) : '-'; }
function getRecipients(asset, lab){
  const list = [lab && lab.contact_email, asset.responsible_email, asset.contract_contact_email].filter(Boolean);
  return [...new Set(list.map(e => String(e).trim()).filter(Boolean))];
}
function dayLabel(days){ return days < 0 ? `เลยกำหนดมา ${Math.abs(days)} วัน` : days === 0 ? 'ครบกำหนดวันนี้' : `เหลืออีก ${days} วัน`; }

/** Days that must pass between battery reminders, given days left. null = too early. */
function batteryCadenceDays(daysLeft){
  if(daysLeft > 90) return null;
  if(daysLeft > 30) return 30;
  if(daysLeft > 7) return 7;
  return 1;
}

async function sendMail({ to, subject, html }){
  await transporter.sendMail({ from: `"ระบบแจ้งเตือน UPS" <${GMAIL_USER}>`, to: to.join(','), subject, html });
}

async function sendBatteryOrMaReminder({ asset, lab, type, dueDate, daysLeft, qrBaseUrl }){
  const recipients = getRecipients(asset, lab);
  if(recipients.length === 0) return 'no_recipient';
  const verb = type === 'battery' ? 'เปลี่ยนแบตเตอรี่' : 'บำรุงรักษา MA (ทุก 4 เดือน)';
  const statusLine = daysLeft < 0 ? `เลยกำหนด${verb}มาแล้ว ${Math.abs(daysLeft)} วัน` : `ใกล้ครบกำหนด${verb}ใน ${daysLeft} วัน`;
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
    <p style="color:#888;font-size:12px;">อีเมลนี้ส่งอัตโนมัติจากระบบบริหารจัดการ UPS — ไม่ต้องตอบกลับอีเมลนี้</p>`;
  await sendMail({ to: recipients, subject: `แจ้งเตือน${verb} — ${asset.asset_id} (${(lab && lab.name) || asset.lab_id})`, html });
  return 'sent';
}

async function sendTicketReminder({ ticket, asset, lab, qrBaseUrl }){
  const recipients = getRecipients(asset || {}, lab);
  if(recipients.length === 0) return 'no_recipient';
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
    <p>ระบบจะส่งอีเมลเตือนซ้ำทุกวันจนกว่าจะมีการกด "ทำเครื่องหมายว่าเสร็จสิ้น" ในหน้า "แจ้งซ่อม"</p>
    <p style="color:#888;font-size:12px;">อีเมลนี้ส่งอัตโนมัติจากระบบบริหารจัดการ UPS — ไม่ต้องตอบกลับอีเมลนี้</p>`;
  await sendMail({ to: recipients, subject: `🚨 [ยังไม่ปิดงาน] แจ้งซ่อมด่วน — ${ticket.asset_id} (ค้าง ${daysOpen} วัน)`, html });
  return 'sent';
}

async function main(){
  console.log(`Firebase project: ${serviceAccount.project_id}  |  sender: ${GMAIL_USER}`);

  if(TEST_EMAIL){
    await sendMail({ to: [TEST_EMAIL], subject: '✅ ทดสอบระบบแจ้งเตือน UPS',
      html: '<p>นี่คืออีเมลทดสอบจากระบบแจ้งเตือน UPS — ถ้าเห็นข้อความนี้ แปลว่าการส่งอีเมลจาก Gmail ทำงานปกติ</p>' });
    console.log(`TEST MODE: sent one test email to ${TEST_EMAIL}. (No reminders were processed.)`);
    return;
  }

  const settingsDoc = await db.collection('app_settings').doc('main').get();
  const qrBaseUrl = settingsDoc.exists ? (settingsDoc.data().qrBaseUrl || '') : '';
  const labsSnap = await db.collection('labs').get();
  const labMap = {}; labsSnap.forEach(d => { labMap[d.id] = d.data(); });
  const assetsSnap = await db.collection('assets').get();

  let sent = 0, noRecipient = 0, noMaDate = 0, noBatteryDate = 0;
  const report = [];

  for(const doc of assetsSnap.docs){
    const a = doc.data(); const ref = doc.ref; const lab = labMap[a.lab_id] || {};
    const rcpt = getRecipients(a, lab).length;
    const row = { id: a.asset_id, rcpt, battery: '', ma: '' };

    // ---- battery ----
    const bDue = nextBatteryDue(a); const bDays = daysUntil(bDue);
    if(bDays === null){ row.battery = 'ไม่มีวันที่เปลี่ยนแบต → ข้าม'; noBatteryDate++; }
    else {
      const cadence = batteryCadenceDays(bDays);
      if(cadence === null){
        row.battery = `${dayLabel(bDays)} → ยังไม่ถึงช่วงเตือน (เริ่มเตือนเมื่อเหลือ ≤ 90 วัน)`;
        if(a.battery_reminder_due_snapshot !== bDue) await ref.update({ battery_reminder_due_snapshot: bDue, battery_reminder_last_sent: null });
      } else {
        const since = a.battery_reminder_due_snapshot !== bDue ? Infinity : daysSince(a.battery_reminder_last_sent);
        if(since >= cadence){
          const st = await sendBatteryOrMaReminder({ asset: a, lab, type: 'battery', dueDate: bDue, daysLeft: bDays, qrBaseUrl });
          if(st === 'sent'){ await ref.update({ battery_reminder_last_sent: new Date().toISOString(), battery_reminder_due_snapshot: bDue }); sent++; row.battery = `${dayLabel(bDays)} → ✅ ส่งอีเมลแล้ว`; }
          else { noRecipient++; row.battery = `${dayLabel(bDays)} → ❌ ถึงเวลาเตือนแล้วแต่ยังไม่มีอีเมลผู้รับ`; }
        } else row.battery = `${dayLabel(bDays)} → เพิ่งเตือนไปแล้ว (รอบถัดไปอีกประมาณ ${Math.ceil(cadence - since)} วัน)`;
      }
    }

    // ---- MA ----
    const mDue = nextMaDue(a); const mDays = daysUntil(mDue);
    if(mDays === null){ row.ma = 'ไม่มีวันที่ MA (ต้องกรอก "วันที่ทำ MA ล่าสุด" หรือ "กำหนด MA ครั้งต่อไป") → ข้าม'; noMaDate++; }
    else if(mDays > 7) row.ma = `${dayLabel(mDays)} → ยังไม่ถึงช่วงเตือน (เตือนเมื่อเหลือ ≤ 7 วัน)`;
    else if(a.ma_reminder_sent_for === mDue) row.ma = `${dayLabel(mDays)} → เตือนไปแล้วสำหรับรอบนี้`;
    else {
      const st = await sendBatteryOrMaReminder({ asset: a, lab, type: 'ma', dueDate: mDue, daysLeft: mDays, qrBaseUrl });
      if(st === 'sent'){ await ref.update({ ma_reminder_sent_for: mDue }); sent++; row.ma = `${dayLabel(mDays)} → ✅ ส่งอีเมลแล้ว`; }
      else { noRecipient++; row.ma = `${dayLabel(mDays)} → ❌ ถึงเวลาเตือนแล้วแต่ยังไม่มีอีเมลผู้รับ`; }
    }
    report.push(row);
  }

  // ---- open repair tickets ----
  const assetById = {}; assetsSnap.forEach(d => { assetById[d.data().asset_id] = d.data(); });
  const ticketsSnap = await db.collection('repair_tickets').where('status', '==', 'รอดำเนินการ').get();
  const ticketRows = [];
  for(const doc of ticketsSnap.docs){
    const t = doc.data(); const lab = labMap[t.lab_id] || {};
    const since = daysSince(t.last_reminder_sent || t.reported_at);
    if(since < 1){ ticketRows.push(`${t.asset_id}: เพิ่งเตือนไปแล้ว`); continue; }
    const st = await sendTicketReminder({ ticket: t, asset: assetById[t.asset_id], lab, qrBaseUrl });
    if(st === 'sent'){ await doc.ref.update({ last_reminder_sent: new Date().toISOString() }); sent++; ticketRows.push(`${t.asset_id}: ✅ ส่งอีเมลเตือนแจ้งซ่อมแล้ว`); }
    else { noRecipient++; ticketRows.push(`${t.asset_id}: ❌ ยังไม่มีอีเมลผู้รับ`); }
  }

  console.log('\n================ รายงานการตรวจสอบรายเครื่อง ================');
  report.forEach(r => console.log(`• ${r.id}  (ผู้รับอีเมล ${r.rcpt} ราย)\n    แบตเตอรี่: ${r.battery}\n    MA: ${r.ma}`));
  console.log(`\nแจ้งซ่อมที่ยังไม่ปิด: ${ticketRows.length} รายการ`); ticketRows.forEach(x => console.log(`    ${x}`));
  console.log('\n================ สรุป ================');
  console.log(`ตรวจเครื่องทั้งหมด ${assetsSnap.docs.length} เครื่อง | ส่งอีเมลสำเร็จ ${sent} ฉบับ | ติดขัดเพราะไม่มีอีเมลผู้รับ ${noRecipient} รายการ | ไม่มีวันที่แบต ${noBatteryDate} เครื่อง | ไม่มีวันที่ MA ${noMaDate} เครื่อง`);

  if(assetsSnap.docs.length === 0) console.log('::warning::ไม่พบข้อมูลเครื่อง UPS ใน Firestore — ตรวจสอบว่ากุญแจ Firebase มาจากโปรเจกต์เดียวกับเว็บ (ups-mdcu-3a6bc)');
  if(noRecipient > 0) console.log(`::warning::มี ${noRecipient} รายการที่ถึงเวลาเตือนแต่ไม่มีอีเมลผู้รับ — กรอกอีเมลในหน้า "ผู้รับผิดชอบห้อง" หรือฟอร์มแก้ไขเครื่อง`);
  if(noMaDate > 0) console.log(`::notice::${noMaDate} เครื่องยังไม่มีวันที่ MA จึงยังไม่มีการเตือน MA — กรอก "วันที่ทำ MA ล่าสุด" ในฟอร์มแก้ไขเครื่อง`);
}

main().catch(err => {
  console.error(err);
  if(err && (err.code === 'EAUTH' || /Invalid login|Username and Password/i.test(String(err.message)))){
    console.error('\n>>> ล็อกอิน Gmail ไม่ผ่าน: ตรวจสอบว่า GMAIL_APP_PASSWORD เป็นรหัสแอป 16 ตัว (ไม่ใช่รหัสผ่านปกติ), เปิดการยืนยัน 2 ขั้นตอนแล้ว และ GMAIL_USER เป็นบัญชีเดียวกับที่สร้างรหัส');
  }
  process.exit(1);
});
