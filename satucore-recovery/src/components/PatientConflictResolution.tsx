import { useEffect, useState } from 'react'
import { Pencil, X } from 'lucide-react'
import { supabase } from '../lib/supabase'

type PatientHumanName = {
  text?: string
  family?: string
  given?: string[]
  prefix?: string[]
  suffix?: string[]
  use?: string
}

type ComponentOption = {
  path: string
  label: string
  value: string
}

type Props = {
  patientId: string
  tenantId: string
  currentName: string
  nameComponents: PatientHumanName[]
  onSubmitted?: () => void
}

function getComponentOptions(names: PatientHumanName[]): ComponentOption[] {
  const options: ComponentOption[] = []

  names.forEach((name, nameIndex) => {
    const base = `Patient.name[${nameIndex}]`
    const useLabel = name.use ? ` (${name.use})` : ''

    if (typeof name.text === 'string' && name.text.trim()) {
      options.push({
        path: `${base}.text`,
        label: `Name text${useLabel}`,
        value: name.text,
      })
    }

    if (typeof name.family === 'string' && name.family.trim()) {
      options.push({
        path: `${base}.family`,
        label: `Family name${useLabel}`,
        value: name.family,
      })
    }

    const componentLabels = {
      given: 'Given name',
      prefix: 'Prefix',
      suffix: 'Suffix',
    }

    for (const key of ['given', 'prefix', 'suffix'] as const) {
      const values = name[key] ?? []

      values.forEach((value, valueIndex) => {
        if (typeof value !== 'string' || !value.trim()) return

        options.push({
          path: `${base}.${key}[${valueIndex}]`,
          label: `${componentLabels[key]} ${valueIndex + 1}${useLabel}`,
          value,
        })
      })
    }
  })

  return options
}

/** Creates a component-level correction proposal only. */
export function PatientConflictResolution({
  patientId,
  tenantId,
  currentName,
  nameComponents,
  onSubmitted,
}: Props) {
  const [open, setOpen] = useState(false)
  const [selectedPath, setSelectedPath] = useState('')
  const [proposedValue, setProposedValue] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!open) return

    const previousBodyOverflow = document.body.style.overflow
    const previousHtmlOverflow = document.documentElement.style.overflow

    document.body.style.overflow = 'hidden'
    document.documentElement.style.overflow = 'hidden'

    return () => {
      document.body.style.overflow = previousBodyOverflow
      document.documentElement.style.overflow = previousHtmlOverflow
    }
  }, [open])

  const options = getComponentOptions(nameComponents)
  const selectedComponent = options.find(
    option => option.path === selectedPath,
  )

  const openModal = () => {
    const first = options[0]

    setSelectedPath(first?.path ?? '')
    setProposedValue(first?.value ?? '')
    setReason('')
    setMessage('')
    setOpen(true)
  }

  const selectComponent = (path: string) => {
    const option = options.find(item => item.path === path)

    setSelectedPath(path)
    setProposedValue(option?.value ?? '')
    setMessage('')
  }

  const submit = async () => {
    if (!supabase || busy) return

    const rationale = reason.trim()
    const nextValue = proposedValue.trim()

    if (!selectedComponent) {
      setMessage('Select an existing Patient name component.')
      return
    }

    if (!nextValue || !rationale) {
      setMessage('Enter the proposed value and reason/evidence.')
      return
    }

    if (nextValue === selectedComponent.value.trim()) {
      setMessage('The proposed value is identical to the current value.')
      return
    }

    setBusy(true)
    setMessage('')

    try {
      const { data: auth, error: authError } =
        await supabase.auth.getUser()

      if (authError) throw authError

      if (!auth.user) {
        throw new Error('Sign in before proposing a Patient correction.')
      }

      const { data: request, error } = await supabase
        .from('patient_correction_requests')
        .insert({
          tenant_id: tenantId,
          patient_id: patientId,
          field_path: selectedComponent.path,
          original_value: selectedComponent.value,
          proposed_value: nextValue,
          reason: rationale,
          status: 'pending',
          requested_by: auth.user.id,
        })
        .select('id')
        .single()

      if (error) throw error

      const { error: auditError } = await supabase
        .from('audit_logs')
        .insert({
          tenant_id: tenantId,
          actor_user_id: auth.user.id,
          action: 'patient_correction_requested',
          entity_type: 'patient_correction_request',
          entity_id: request.id,
          outcome: 'success',
          metadata: {
            patient_id: patientId,
            field_path: selectedComponent.path,
            original_value: selectedComponent.value,
            proposed_value: nextValue,
          },
        })

      if (auditError) {
        setMessage(
          `Proposal saved (${request.id}), but the audit event could not be written: ${auditError.message}`,
        )
        return
      }

      setMessage(
        'Component correction submitted for human review. Patient and FHIR records have not been changed.',
      )

      setOpen(false)
      onSubmitted?.()
    } catch (error) {
      setMessage((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className="secondary-btn patient-conflict-trigger"
        onClick={openModal}
        disabled={options.length === 0}
        title={
          options.length === 0
            ? 'No existing structured name components to correct'
            : undefined
        }
      >
        <Pencil size={13} /> Propose correction
      </button>

      {open && (
        <div
          className="modal-backdrop patient-correction-backdrop"
          role="presentation"
          onMouseDown={event => {
            if (event.target === event.currentTarget && !busy) {
              setOpen(false)
            }
          }}
        >
          <section
            className="login-modal patient-correction-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`correction-title-${patientId}`}
          >
            <header className="patient-correction-header">
              <button
                type="button"
                className="modal-close secondary-btn"
                aria-label="Close"
                onClick={() => setOpen(false)}
                disabled={busy}
              >
                <X size={16} />
              </button>

              <div className="eyebrow">
                HUMAN REVIEW · PATIENT IDENTITY
              </div>

              <h2 id={`correction-title-${patientId}`}>
                Propose name component correction
              </h2>

              <p>
                Select one existing name component. Only that component
                will be proposed for correction. No Patient or FHIR
                data is changed at this stage.
              </p>
            </header>

            <div className="patient-correction-body">
              <label>Current complete name</label>
              <input value={currentName} readOnly />

              <label htmlFor={`correction-component-${patientId}`}>
                Component to correct
              </label>

              <select
                id={`correction-component-${patientId}`}
                value={selectedPath}
                onChange={event => selectComponent(event.target.value)}
                disabled={busy || options.length === 0}
              >
                {options.map(option => (
                  <option key={option.path} value={option.path}>
                    {option.label} — {option.value}
                  </option>
                ))}
              </select>

              <label>Exact field path</label>
              <input value={selectedPath} readOnly />

              <label>Current component value</label>
              <input
                value={selectedComponent?.value ?? ''}
                readOnly
              />

              <label>Proposed replacement</label>
              <input
                value={proposedValue}
                onChange={event => setProposedValue(event.target.value)}
                maxLength={200}
                disabled={!selectedComponent || busy}
              />

              <label>Reason / evidence (required)</label>
              <textarea
                value={reason}
                onChange={event => setReason(event.target.value)}
                rows={4}
                maxLength={2000}
                placeholder="Explain the source of the correction and evidence reviewed."
                disabled={busy}
              />

              {message && (
                <p className="patient-correction-message" role="status">
                  {message}
                </p>
              )}
            </div>

            <footer className="patient-correction-footer">
              <div className="action-row">
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => setOpen(false)}
                  disabled={busy}
                >
                  Cancel
                </button>

                <button
                  type="button"
                  className="primary-btn"
                  onClick={() => void submit()}
                  disabled={busy || !selectedComponent}
                >
                  {busy ? 'Submitting…' : 'Submit for review'}
                </button>
              </div>
            </footer>
          </section>
        </div>
      )}

      <style>{`
        .patient-correction-backdrop {
          position: fixed;
          inset: 0;
          z-index: 100;
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: auto;
          padding: 20px;
          overscroll-behavior: contain;
        }

        .patient-correction-modal {
          box-sizing: border-box;
          display: flex;
          flex-direction: column;
          width: min(560px, 100%);
          height: min(760px, calc(100vh - 40px));
          height: min(760px, calc(100dvh - 40px));
          max-height: calc(100dvh - 40px);
          min-height: 0;
          padding: 0;
          overflow: hidden;
        }

        .patient-correction-header {
          position: relative;
          z-index: 2;
          flex: 0 0 auto;
          padding: 28px 30px 20px;
          background: #fff;
          border-bottom: 1px solid #e9e5f0;
          box-shadow: 0 4px 12px rgba(35, 20, 60, 0.06);
        }

        .patient-correction-header h2 {
          margin-right: 36px;
        }

        .patient-correction-body {
          flex: 1 1 auto;
          min-height: 0;
          overflow-y: auto;
          overflow-x: hidden;
          overscroll-behavior: contain;
          -webkit-overflow-scrolling: touch;
          padding: 24px 30px;
        }

        .patient-correction-body > label {
          display: block;
          margin-top: 14px;
        }

        .patient-correction-body > label:first-child {
          margin-top: 0;
        }

        .patient-correction-body > input,
        .patient-correction-body > select,
        .patient-correction-body > textarea {
          box-sizing: border-box;
          width: 100%;
          max-width: 100%;
        }

        .patient-correction-footer {
          position: relative;
          z-index: 2;
          flex: 0 0 auto;
          padding: 16px 30px;
          background: #fff;
          border-top: 1px solid #e9e5f0;
          box-shadow: 0 -4px 12px rgba(35, 20, 60, 0.05);
        }

        .patient-correction-footer .action-row {
          margin: 0;
        }

        @media (max-width: 600px) {
          .patient-correction-backdrop {
            padding: 10px;
          }

          .patient-correction-modal {
            height: calc(100vh - 20px);
            height: calc(100dvh - 20px);
            max-height: calc(100dvh - 20px);
          }

          .patient-correction-header {
            padding: 22px 20px 16px;
          }

          .patient-correction-body {
            padding: 20px;
          }

          .patient-correction-footer {
            padding: 14px 20px;
          }
        }
      `}</style>
    </>
  )
}
