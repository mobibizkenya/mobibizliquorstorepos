import axios from 'axios';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { phone, amount, orgId } = req.body;
  
  if (!phone || !amount || !orgId) {
    return res.status(400).json({ error: 'Missing required fields (phone, amount, orgId)' });
  }

  // Safaricom Endpoints
  const baseUrl = process.env.MPESA_ENV === 'production' 
    ? 'https://api.safaricom.co.ke' 
    : 'https://sandbox.safaricom.co.ke';

  try {
    // 1. Get OAuth Token
    const auth = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
    const { data: { access_token } } = await axios.get(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${auth}` }
    });

    // 2. Generate Password & Timestamp
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, -3);
    const password = Buffer.from(`${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`).toString('base64');

    // 3. Initiate STK Push
    const stkRes = await axios.post(`${baseUrl}/mpesa/stkpush/v1/processrequest`, {
      BusinessShortCode: process.env.MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline', 
      Amount: amount,
      PartyA: phone,
      PartyB: process.env.MPESA_SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: `https://${req.headers.host}/api/mpesa/callback`,
      AccountReference: orgId, // Identifies the organization
      TransactionDesc: 'POS Subscription'
    }, {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    res.status(200).json({ ok: true, data: stkRes.data });
  } catch (error) {
    console.error('STK Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to initiate M-Pesa payment' });
  }
}
