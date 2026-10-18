/* Backend connection settings.
   The publishable key is PUBLIC BY DESIGN — every table has RLS on and grants nothing to
   anonymous callers. The only anon-callable path is portal_lookup() with a valid job code.
   NEVER put the service_role / secret key in this file. */
window.SITE_CONFIG = {
  url: 'SUPABASE_URL',            // e.g. https://abcd.supabase.co
  key: 'SUPABASE_PUBLISHABLE_KEY',

  /* One-button demo login for local dev only. Two guards keep it safe:
     (1) it evaluates false off localhost/file:, so the real login shows on any live domain;
     (2) deploy-cloudflare.sh strips the password and aborts if it survives. */
  demoAccess: {
    enabled: (function () {
      var h = location.hostname;
      return h === 'localhost' || h === '127.0.0.1' || h === '::1' ||
             location.protocol === 'file:';
    })(),
    email:    'crew@example.com',
    password: 'CHANGE_ME_LOCAL_ONLY'
  },

  business: {
    name:  'Business Name',
    phone: '(000) 000-0000',
    tel:   '+10000000000',
    email: 'hello@example.com',
    payTo: 'Business Name',
    methods: [
      { label: 'Zelle', detail: 'Send to (000) 000-0000 — include your job code in the memo.' },
      { label: 'Check', detail: 'Made out to Business Name. Write your job code on the memo line.' },
      { label: 'Card',  detail: 'Call the office at (000) 000-0000 to pay by card over the phone.' },
      { label: 'Cash',  detail: 'Accepted on site. Ask the crew lead for a receipt.' }
    ]
  }
};
