// Supabase browser-safe connection settings.
// Fill in the Project URL and the *anon/public* key after applying
// ../supabase/schema.sql.  Never put a service_role key in this PWA.
// This file is intentionally not precached by the service worker so a changed
// deployment setting is used on the next page load.
self.RICE_SUPABASE_CONFIG = Object.freeze({
  url: 'https://wffyctbnhawfgnyhxiwe.supabase.co',
  anonKey: 'sb_publishable_dwhVdM5DtETHF-cIFgHgPA_kdsTpI_Y',
  table: 'rice_measurements',
  deviceRpc: 'register_rice_device_for_farm',
  chartRpc: 'get_my_rice_chart',
  profileRpc: 'complete_rice_profile',
  farmsRpc: 'get_my_rice_farms',
  devicesRpc: 'get_my_rice_devices',
  renameFarmRpc: 'rename_my_rice_farm',
});
