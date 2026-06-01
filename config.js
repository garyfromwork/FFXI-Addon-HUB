// Supabase credentials — bundled into the installer by electron-builder.
// The anon key is safe to include here; it's a public key designed for
// client-side use. Security comes entirely from your Supabase RLS policies.
module.exports = {
  supabaseUrl: process.env.SUPABASE_URL || 'https://pnqbeicfojkrpnwuiwds.supabase.co',
  supabaseKey: process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBucWJlaWNmb2prcnBud3Vpd2RzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAwNzc2NzMsImV4cCI6MjA5NTY1MzY3M30.TmjtS4R28w7f17-CK8HOUKspbx_nSaQf94XQ4Ijedmo',
};
