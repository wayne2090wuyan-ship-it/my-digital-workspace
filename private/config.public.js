// Public configuration only. Real-cloud safety tests are recorded in
// docs/cloud-acceptance.md. Set enabled:false to lock the private entry point.
// Environment IDs identify services; they are not admin credentials.
export default Object.freeze({
  enabled: true,
  environmentId: 'mdw-private-test-d3eilmu4efb587e',
  region: 'ap-shanghai',
  functionName: 'mdwPrivateApi'
});
