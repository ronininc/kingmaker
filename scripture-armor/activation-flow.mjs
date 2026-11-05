export async function activateArmor({ input, alreadyActive, verifyEntitlement, ensureIdentity, acceptTerms, migrateCredentials, recordFeed, recordPaidActivation }) {
  if (alreadyActive) return { identity: null, entitlement: null, migrated: 0, alreadyActive: true };
  if (input?.acceptTerms !== true || input?.confirmMigration !== true) throw new Error('activation requires terms and migration confirmation');
  const entitlement = await verifyEntitlement(input);
  const identity = ensureIdentity();
  acceptTerms();
  const migration = migrateCredentials();
  recordFeed({ migrated: migration.imported.length });
  recordPaidActivation(identity, entitlement);
  return { identity, entitlement, migrated: migration.imported.length };
}
