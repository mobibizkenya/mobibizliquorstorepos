import admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  });
}
const db = admin.firestore();

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const cb = req.body?.Body?.stkCallback;
  if (!cb) return res.status(200).json({ ResultCode: 0, ResultDesc: 'No callback body' });

  const checkoutId = cb.CheckoutRequestID;
  const resultCode = cb.ResultCode;

  // ─── 1. Look up which org sent this STK push ─────────────────
  let orgId = null;
  let requestDoc = null;
  try {
    requestDoc = await db.collection('stkRequests').doc(checkoutId).get();
    if (requestDoc.exists) {
      const data = requestDoc.data();
      orgId = data.orgId;
      if (data.status === 'success') {
        // Idempotent: Safaricom retries → don't double-credit
        console.log(`[callback] ${checkoutId} already processed`);
        return res.status(200).json({ ResultCode: 0, ResultDesc: 'Already processed' });
      }
    }
  } catch (err) {
    console.error('[callback] stkRequests lookup failed:', err);
  }

  if (!orgId) {
    console.warn(`[callback] no stkRequests doc for ${checkoutId} — cannot route`);
    return res.status(200).json({ ResultCode: 0, ResultDesc: 'Unknown request' });
  }

  // ─── 2. Handle result ────────────────────────────────────────
  if (resultCode === 0) {
    const meta = {};
    (cb.CallbackMetadata?.Item || []).forEach(i => { meta[i.Name] = i.Value; });
    const receipt = meta.MpesaReceiptNumber || 'Unknown';
    const amount  = Number(meta.Amount) || 0;
    const phone   = meta.PhoneNumber || '';

    const now = Date.now();

    try {
      // ── Schema A: MOBIBIZ — subscriptions/{orgId}.paidUntil = number
      const subRef = db.collection('subscriptions').doc(orgId);
      const subSnap = await subRef.get();
      const cur = subSnap.exists ? subSnap.data() : {};
      const base = Math.max(Number(cur.paidUntil) || 0, now);
      const newPaidUntil = base + THIRTY_DAYS;

      await subRef.set({
        status:        'active',
        paidUntil:     newPaidUntil,
        graceDays:     cur.graceDays ?? 3,
        plan:          cur.plan || 'monthly',
        pricePerMonth: cur.pricePerMonth || 1500,
        orgId,
        lastPayment:   { amount, receipt, phone, at: now }
      }, { merge: true });

      // ── Schema B: Melah — settings/main.subscriptionExpiry = ISO string
      const setRef = db.collection('settings').doc('main');
      const setSnap = await setRef.get();
      const sd = setSnap.exists ? setSnap.data() : {};
      const curExpiryMs = sd.subscriptionExpiry ? new Date(sd.subscriptionExpiry).getTime() : 0;
      const newExpiryMs = Math.max(curExpiryMs, now) + THIRTY_DAYS;

      const payments = [
        ...(sd.subscriptionPayments || []),
        { receipt, phone, amount, at: new Date(now).toISOString(), method: 'M-Pesa' }
      ].slice(-50);

      await setRef.set({
        subscriptionExpiry:      new Date(newExpiryMs).toISOString(),
        subscriptionLastPayment: new Date(now).toISOString(),
        subscriptionPayments:    payments
      }, { merge: true });

      // ── Mark request successful
      await db.collection('stkRequests').doc(checkoutId).set({
        status:      'success',
        resultCode,
        receipt,
        amount,
        completedAt: now
      }, { merge: true });

      console.log(`✅ Renewed org=${orgId} until ${new Date(newPaidUntil).toISOString()}`);
    } catch (err) {
      console.error('❌ Firestore write failed:', err);
    }
  } else {
    try {
      await db.collection('stkRequests').doc(checkoutId).set({
        status:     'failed',
        resultCode,
        resultDesc: cb.ResultDesc || '',
        completedAt: Date.now()
      }, { merge: true });
      console.log(`⚠️ Payment failed for org=${orgId} code=${resultCode}`);
    } catch (err) {
      console.error('Failed to record failure:', err);
    }
  }

  // ALWAYS 200 — otherwise Safaricom retries for hours
  return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
}
