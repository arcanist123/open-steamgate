@AbapCatalog.sqlViewName: 'ZVOSDAMDP'
@AbapCatalog.compiler.compareFilter: true
@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'OSD system status: AMDP methods and their engine'
define view ZC_OSD_AMDP
  as select from zosd_amdp
{
      @EndUserText.label: 'Class'
  key class_name  as ClassName,
      @EndUserText.label: 'Method'
  key method_name as MethodName,
      @EndUserText.label: 'Kind'
      kind        as Kind,
      @EndUserText.label: 'Portable subset'
      portable    as Portable,
      @EndUserText.label: 'Engine'
      engine      as Engine,
      @EndUserText.label: 'Reason'
      reason      as Reason,
      @EndUserText.label: 'Portable refusal'
      refusal     as Refusal
}
