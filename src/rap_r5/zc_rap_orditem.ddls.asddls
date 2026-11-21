@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'RAP order item projection (R5)'
define view entity ZC_RAP_ORDITEM
  as projection on ZI_RAP_ORDITEM
{
  key order_id        as OrderId,
  key item_no         as ItemNo,
      product         as Product,
      quantity        as Quantity,
      item_changed_at as ItemChangedAt,
      _Order : redirected to parent ZC_RAP_ORDER
}
