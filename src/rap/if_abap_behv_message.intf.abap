INTERFACE if_abap_behv_message PUBLIC.
* What %MSG of a REPORTED row holds: a message with a severity. Clean-room;
* the severity is a one-character code rather than an enumeration, with the
* constant names a behavior pool spells (severity-error and so on).

  INTERFACES if_t100_dyn_msg.

  TYPES t_severity TYPE c LENGTH 1.

  CONSTANTS:
    BEGIN OF severity,
      none        TYPE t_severity VALUE ' ',
      error       TYPE t_severity VALUE 'E',
      warning     TYPE t_severity VALUE 'W',
      information TYPE t_severity VALUE 'I',
      success     TYPE t_severity VALUE 'S',
    END OF severity.

  DATA m_severity TYPE t_severity.

ENDINTERFACE.
