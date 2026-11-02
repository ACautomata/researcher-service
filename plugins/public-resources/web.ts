import { definePluginWeb } from '../../frontend/src/plugins/api'
import PublicResourceCard from './components/PublicResourceCard.vue'

// Keep the tool key aligned with RESOURCE_SEARCH_TOOL in server.ts without
// importing the server implementation into the browser bundle.
export default definePluginWeb({ components: { public_resource_search: PublicResourceCard } })
