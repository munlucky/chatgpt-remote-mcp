export function catalogFeaturesFromEnv(env) {
  const enabled = value => ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
  return { operatorApprovalEnabled: enabled(env.MCP_OPERATOR_APPROVAL_ENABLED), kernelReviewEnabled: enabled(env.MCP_KERNEL_REVIEW_ENABLED) };
}

export function expectedToolCount(features) {
  return 25 + (features.operatorApprovalEnabled ? 3 : 0) + (features.kernelReviewEnabled ? 2 : 0);
}

export function validateOptionalToolCatalog(catalog, features) {
  if (!Array.isArray(catalog) || catalog.length !== expectedToolCount(features)) throw new Error('Public tool catalog is incomplete');
  const names = new Set(catalog.map(tool => tool.name));
  if (names.size !== catalog.length) throw new Error('Public tool catalog contains duplicate names');
  for (const [enabled, tools] of [
    [features.operatorApprovalEnabled, ['request_operator_approval', 'get_operator_approval', 'execute_approved_operation']],
    [features.kernelReviewEnabled, ['get_kernel_review_status', 'start_kernel_review']],
  ]) for (const name of tools) {
    if (names.has(name) !== Boolean(enabled)) throw new Error(`Optional tool advertisement mismatch: ${name}`);
  }
  return { operatorApprovalToolsAdvertised: features.operatorApprovalEnabled, kernelReviewToolsAdvertised: features.kernelReviewEnabled };
}
