@AbapCatalog.sqlViewName: 'ZVOSDSYS'
@AbapCatalog.compiler.compareFilter: true
@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'OSD system status: the system'
// The one row the facade refreshes before a read of ZOSD_STATUS_SRV. The
// five associations are unconditional on purpose: there is one system, and
// every process, port, service, pack and database fact belongs to it, so
// the ON condition guards nothing and the expand reads the whole target set.
define view ZC_OSD_SYSTEM
  as select from zosd_sys
  association [0..*] to ZC_OSD_PROCESS as _Processes on  _Processes.Pid     >= 0
  association [0..*] to ZC_OSD_PORT    as _Ports     on  _Ports.Port        >= 0
  association [0..*] to ZC_OSD_SERVICE as _Services  on  _Services.Path     <> ''
  association [0..*] to ZC_OSD_PACK    as _Packs     on  _Packs.Name        <> ''
  association [0..*] to ZC_OSD_DATABASE as _Database  on  _Database.Name      <> ''
  association [0..*] to ZC_OSD_WP      as _WorkProcesses
                                              on  _WorkProcesses.Wpno  >= 0
{
      @EndUserText.label: 'System'
  key sid         as Sid,
      @EndUserText.label: 'Host'
      host_kind   as HostKind,
      @EndUserText.label: 'Generation built'
      gen_live    as GenLive,
      @EndUserText.label: 'Generation serving'
      gen_serving as GenServing,
      @EndUserText.label: 'In step'
      synced      as Synced,
      @EndUserText.label: 'Work processes'
      workers     as Workers,
      @EndUserText.label: 'Started'
      started_at  as StartedAt,
      @EndUserText.label: 'Snapshot taken'
      snap_at     as SnapAt,
      @EndUserText.label: 'Tree'
      root_hint   as RootHint,
      @EndUserText.label: 'Work process'
      pid         as Pid,
      _Processes,
      _Ports,
      _Services,
      _Packs,
      _WorkProcesses,
      _Database
}
