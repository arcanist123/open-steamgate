@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'RAP note demo, handlers in the system form'
define root view entity ZI_RAP_NOTE_SF as select from zrap_note
{
  key note_id as NoteId,
      note_text as NoteText,
      status as Status
}
