@AbapCatalog.sqlViewName: 'ZVOSDWP'
@AbapCatalog.compiler.compareFilter: true
@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'OSD system status: the work processes of the sidecar'
define view ZC_OSD_WP
  as select from zosd_wp
{
      @EndUserText.label: 'Work process'
  key wpno     as Wpno,
      @EndUserText.label: 'Kind'
      kind     as Kind,
      @EndUserText.label: 'State'
      state    as State,
      @EndUserText.label: 'Generation'
      generation as Generation,
      @EndUserText.label: 'Step started'
      started  as Started,
      @EndUserText.label: 'User'
      username as Username,
      @EndUserText.label: 'Report'
      report   as Report
}
