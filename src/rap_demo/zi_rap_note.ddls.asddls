@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'Original RAP note demo'
define root view entity ZI_RAP_NOTE as select from zrap_note
{
  key note_id as NoteId,
      note_text as NoteText,
      status as Status
}
