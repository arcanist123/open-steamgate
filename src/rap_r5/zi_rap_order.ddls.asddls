@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'RAP order demo (R5)'
define root view entity ZI_RAP_ORDER as select from zrap_order
  composition [0..*] of ZI_RAP_ORDITEM as _Items
{
  key order_id,
      description,
      status,
      @Semantics.user.createdBy: true
      created_by,
      @Semantics.systemDateTime.lastChangedAt: true
      last_changed_at,
      _Items
}
