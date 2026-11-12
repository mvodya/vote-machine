import {up as createConnections} from './1795737600000-mcp-room-access.mjs';
import {up as addFullAccess} from './1795824000000-mcp-full-room-access.mjs';

// Remove unused client grants and leave room tokens and drafts in place
export function up(pgm) {
  pgm.sql(`
    DROP FUNCTION vm_mcp_oauth(uuid,bytea,text,jsonb),vm_mcp_operation(uuid,bytea,text,jsonb),
      vm_mcp_oauth_before_full_access(uuid,bytea,text,jsonb),vm_mcp_operation_before_full_access(uuid,bytea,text,jsonb);
    DROP TABLE mcp_question_batches,mcp_connections,mcp_clients;
  `);
}

// Restore the old schema empty so removed grants stay invalid
export function down(pgm) {
  createConnections(pgm);
  addFullAccess(pgm);
}
