import { Select, type PortalContainer } from '@cloudflare/kumo'
import { AiModelInfo } from '@gadgets/workshop-shared/api'
import { modelOptionLabel } from '../modelListDisplay'
import { ConnectionConfigField } from './ConnectionConfigField'

export interface AiModelConnectionConfigProps {
  availableModels: AiModelInfo[]
  selectedModelId: string | undefined
  onSelectedModelIdChange: (id: string | undefined) => void
  selectContainer?: PortalContainer
}

export function AiModelConnectionConfig({
  availableModels,
  selectedModelId,
  onSelectedModelIdChange,
  selectContainer,
}: AiModelConnectionConfigProps) {
  return (
    <section className="grid gap-3">
      <ConnectionConfigField
        label="Model"
        description="Choose the model this connection can use."
      >
        <Select
          aria-label="Select an AI model"
          className="w-full text-ui-md [&_button]:!h-9"
          container={selectContainer}
          placeholder="Select an AI model"
          value={selectedModelId}
          onValueChange={(v) => onSelectedModelIdChange(v as string | undefined)}
          renderValue={(id) => {
            const model = availableModels.find((m) => m.id === id)
            return model ? modelOptionLabel(model) : id
          }}
        >
          {availableModels.map(model => (
            <Select.Option key={model.id} value={model.id}>
              {modelOptionLabel(model)}
            </Select.Option>
          ))}
        </Select>
      </ConnectionConfigField>
    </section>
  )
}
