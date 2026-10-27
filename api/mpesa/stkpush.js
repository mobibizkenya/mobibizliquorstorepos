import axios from 'axios';
import admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  });
}
const db = admin.firestore();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { phone, amount, orgId, accountReference } = req.body;

  if (!phone || !amount) {
    return res.status(400).json({ error: 'Missing required fields (phone, amount)' });
  }

  // MOBIBIZ sends a real orgId; Melah should now send orgId:'melah-branding'
  const effectiveOrgId = orgId || 'melah-branding';

  const baseUrl = process.env.MPESA_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';

  const storeNumber = process.env.MPESA_SHORTCODE || '1347027';
  const tillNumber  = '1816752';

  try {
    const auth = Buffer.from(
      `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
    ).toString('base64');

    const { data: { access_token } } = await axios.get(
      `${baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
      { headers: { Authorization: `Basic ${auth}` } }
    );

    // Timestamp in EAT
    const eatDate = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const p2 = n => String(n).padStart(2, '0');
    const timestamp =
      `${eatDate.getUTCFullYear()}${p2(eatDate.getUTCMonth() + 1)}${p2(eatDate.getUTCDate())}` +
      `${p2(eatDate.getUTCHours())}${p2(eatDate.getUTCMinutes())}${p2(eatDate.getUTCSeconds())}`;

    const password = Buffer.from(
      `${storeNumber}${process.env.MPESA_PASSKEY}${timestamp}`
    ).toString('base64');

    // Callback MUST be the production URL, not a preview hash
    const callbackUrl =
      process.env.MPESA_CALLBACK_URL ||
      `https://${req.headers.host}/api/mpesa/callback`;

    const payload = {
      BusinessShortCode: storeNumber,
      Password:          password,
      Timestamp:         timestamp,
      TransactionType:   'CustomerBuyGoodsOnline',
      Amount:            Math.round(amount),
      PartyA:            phone,
      PartyB:            tillNumber,
      PhoneNumber:       phone,
      CallBackURL:       callbackUrl,
      AccountReference:  (accountReference || `POS-${effectiveOrgId}`).slice(0, 12),
      TransactionDesc:   'POS Subscription'
    };

    const stkRes = await axios.post(
      `${baseUrl}/mpesa/stkpush/v1/processrequest`,
      payload,
      { headers: { Authorization: `Bearer ${access_token}` } }
    );

    const checkoutId = stkRes.data.CheckoutRequestID;

    // ⭐ CRITICAL: save checkout → orgId so the callback can route correctly
    await db.collection('stkRequests').doc(checkoutId).set({
      orgId:     effectiveOrgId,
      phone,
      amount:    Number(amount),
      status:    'pending',
      createdAt: Date.now()
    });

    console.log(`[STK] org=${effectiveOrgId} checkout=${checkoutId} callback=${callbackUrl}`);

    // Return BOTH shapes so MOBIBIZ (doesn't parse) and Melah (parses) both work
    return res.status(200).json({
      success:           true,
      ok:                true,
      checkoutRequestId: checkoutId,
      CheckoutRequestID: checkoutId,
      message:           stkRes.data.CustomerMessage || 'STK push sent',
      data:              stkRes.data
    });

  } catch (error) {
    const errorData = error.response?.data || error.message;
    console.error('SAFARICOM STK ERROR:', JSON.stringify(errorData, null, 2));
    return res.status(500).json({
      error:   'Failed to initiate M-Pesa payment',
      message: errorData?.errorMessage || errorData,
      details: errorData
    });
  }
}
