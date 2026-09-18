// Validate Actions configuration without printing any secret values.
function configurationErrors(env) {
  const required = ['DATABASE_URL', 'ENCRYPTION_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SMARTSHEET_CLIENT_ID', 'SMARTSHEET_CLIENT_SECRET'];
  const errors = required.filter(name => !env[name]?.trim()).map(name => `${name} is missing. Add it under Settings > Secrets and variables > Actions > Secrets (copy the production value from Render).`);
  if (env.DATABASE_URL?.trim()) {
    try {
      const url = new URL(env.DATABASE_URL);
      if (!['mongodb:', 'mongodb+srv:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) {
        errors.push('DATABASE_URL must be an Atlas URL containing the database name, for example /smartsheet_gcal_sync before the question mark.');
      }
    } catch { errors.push('DATABASE_URL is not a valid connection URL. Check its format and encode special characters in the password.'); }
  }
  if (env.ENCRYPTION_KEY?.trim() && env.ENCRYPTION_KEY.length < 16) errors.push('ENCRYPTION_KEY is too short. Copy the existing value from Render; do not generate a replacement.');
  return errors;
}
module.exports = { configurationErrors };
if (require.main === module) {
  const errors = configurationErrors(process.env);
  for (const error of errors) console.error(`::error::${error}`);
  if (errors.length) process.exitCode = 1;
  else {
    console.log('Required scheduled-sync settings are present and formatted correctly.');
    if (!process.env.GROQ_API_KEY?.trim()) console.warn('::warning::GROQ_API_KEY is missing. Structured rows can sync, but complex rows requiring AI will need this secret.');
  }
}
