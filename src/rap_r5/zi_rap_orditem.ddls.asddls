@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'RAP order item demo (R5)'
define view entity ZI_RAP_ORDITEM as select from zrap_orditem
  association to parent ZI_RAP_ORDER as _Order on $projection.order_id = _Order.order_id
{
  key order_id,
  key item_no,
      product,
      quantity,
      @Semantics.systemDateTime.localInstanceLastChangedAt: true
      item_changed_at,
      _Order
}
