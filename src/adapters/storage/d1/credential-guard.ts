import { AccessError,type CredentialLease } from '../../../core/access/model.js';
import type { D1Session } from './binding.js';

/** The SQL clock also closes expiry between JWT validation and the atomic write. */
export function credentialGuard(session:D1Session,lease:CredentialLease){
 return [session.prepare(`INSERT INTO cloud_auth_guard VALUES(1,CASE WHEN ? > unixepoch() AND EXISTS(
  SELECT 1 FROM cloud_auth_versions WHERE policy_id=? AND version=? AND state='active' AND valid_until>unixepoch()
  AND version=(SELECT MAX(version) FROM cloud_auth_versions WHERE policy_id=?)) THEN 1 ELSE 0 END)`)
  .bind(lease.expires_at,lease.policy_id,lease.version,lease.policy_id),session.prepare('DELETE FROM cloud_auth_guard WHERE id=1')];
}
export function credentialError(e:unknown){
 if(e instanceof Error&&e.message.includes('skilly_cloud_auth_allowed'))throw new AccessError(401,'authentication_changed');
}
