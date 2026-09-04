/**
 * The approved Gupshup templates, and — critically — what each variable means.
 *
 * Every one of these was read back from the Gupshup template API on 4 Sep 2026
 * rather than assumed. Two assumptions that would have failed silently:
 *
 *   • eventday_reminder_kpyf_with_location has NO name variable. {{1}} is the
 *     session start time. Auto-prepending the candidate's name (as every other
 *     template here expects) would have put "Chaitanya" where "10 AM" belongs.
 *
 *   • Meta drops a template whose parameter count doesn't match, and both BSPs
 *     still answer 200. So the count below is not documentation — it is the
 *     thing that makes the message arrive.
 *
 * CATEGORY MATTERS FOR BULK. Meta applies per-user marketing limits and
 * throttles MARKETING templates far harder than UTILITY. After the Flaxxa
 * number was spam rate-limited on 4 Sep, prefer UTILITY for anything sent at
 * scale — hence certificate_kpyf (utility, plain wording) over
 * certificate_youthfest (marketing, nicer wording) for the ~900 certificate run.
 *
 * Venue wording differs between templates and both are hardcoded:
 *   kpyf_2hr_reminde                    → "Gadiraju Convention Centre"
 *   eventday_reminder_kpyf_with_location→ "Gadiraju Palace"
 * Neither is a variable, so fixing that needs a new template + approval.
 */

const GUPSHUP_TEMPLATES = {
  // Registration confirmation, split by gender so each student gets the right
  // WhatsApp group. The "Join Group" button points at go.harekrishnavizag.org,
  // a redirect HKM controls — so a full or reset group is fixed by repointing
  // it, with no template re-approval and no dead links in messages already
  // delivered. Verified 4 Sep 2026:
  //   /wakpb2026 → chat.whatsapp.com/IanhUm6sUsU3OR3HrdRKFC  (boys)
  //   /wakpg2026 → chat.whatsapp.com/LjoVMBea73c1TtM358MNt0  (girls)
  //
  // These REPLACE kpyf_group_boys/girls (e3f1bda8… / 149fbf0b…), whose
  // rebrand.ly/KPYFB and /KPYFG links are dead — they return no redirect at
  // all, so those templates would send students to a broken button.
  'registration:male': {
    id: process.env.GUPSHUP_TMPL_REGISTRATION_MALE || 'af2bef30-c192-4b5b-bbf8-668b86c5292d',
    name: 'kp_registration_confirmation_male',
    category: 'UTILITY',
    vars: 1, // {{1}} name
    params: (c) => [c.name],
  },
  'registration:female': {
    id: process.env.GUPSHUP_TMPL_REGISTRATION_FEMALE || 'c3679abd-513b-40e9-9d15-b9b24fae2ffc',
    name: 'kp_registration_confirmation_female',
    category: 'UTILITY',
    vars: 1, // {{1}} name
    params: (c) => [c.name],
  },

  slotchange: {
    id: process.env.GUPSHUP_TMPL_SLOTCHANGE || 'd7c6e193-b649-483c-8e11-afc969d84eb0',
    name: 'kp_slot_change',
    category: 'UTILITY',
    vars: 3, // {{1}} name, {{2}} reporting time, {{3}} meal
    params: (c, v) => [c.name, v.reportingTime, v.meal],
  },

  'reminder:twoHour': {
    id: process.env.GUPSHUP_TMPL_REMINDER_2HOUR || 'ce707c05-54ef-4e80-b0fd-c0f9885288f6',
    name: 'kpyf_2hr_reminde',
    category: 'MARKETING', // throttled harder than utility — fine at this volume
    vars: 2, // {{1}} name, {{2}} reporting time. Venue hardcoded.
    params: (c, v) => [c.name, v.reportingTime],
  },

  'reminder:eventDay': {
    id: process.env.GUPSHUP_TMPL_REMINDER_EVENTDAY || 'b4af5540-be96-4c65-98a5-8c09ee42529d',
    name: 'eventday_reminder_kpyf_with_location',
    category: 'UTILITY',
    vars: 3, // {{1}} START TIME (not the name!), {{2}} reach-by time, {{3}} meal
    params: (c, v) => [v.startTime, v.reachBy, v.meal],
  },

  attendance: {
    id: process.env.GUPSHUP_TMPL_ATTENDANCE || '88021e4e-88ae-4cba-bdba-f9b1be3b4948',
    name: 'attendance_confirm',
    category: 'UTILITY',
    vars: 1, // {{1}} name. Body still says "Krishna Pulse 2K25".
    params: (c) => [c.name],
  },

  certificate: {
    // Utility + document. certificate_youthfest (4b40f2ce…) reads better but is
    // MARKETING, and marketing throttling is exactly what we cannot afford on a
    // ~900-message run.
    id: process.env.GUPSHUP_TMPL_CERTIFICATE || '1e5b2dd0-3ee7-4d8d-bd41-9a80073b1399',
    name: 'certificate_kpyf',
    category: 'UTILITY',
    vars: 1, // {{1}} name, plus the PDF as the document header
    params: (c) => [c.name],
  },
};

/** Resolve a kind to its template + the exact parameter list it expects. */
function gupshupTemplateFor(kind, candidate, values = {}) {
  const t = GUPSHUP_TEMPLATES[kind];
  if (!t) return null;

  const params = t.params(candidate, values).map(v => String(v ?? '').replace(/\s+/g, ' ').trim());

  if (params.length !== t.vars) {
    throw new Error(
      `[templates] ${t.name} expects ${t.vars} variable(s) but ${params.length} were built — ` +
      `Meta would accept this and then silently drop it`
    );
  }
  if (params.some(p => !p)) {
    throw new Error(`[templates] ${t.name}: a variable resolved empty (${JSON.stringify(params)})`);
  }

  return { ...t, params };
}

module.exports = { GUPSHUP_TEMPLATES, gupshupTemplateFor };
