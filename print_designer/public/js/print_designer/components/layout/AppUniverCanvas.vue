<template>
	<div class="univer-canvas">
		<div class="univer-header">
			<span class="univer-title">
				{{
					UniverStore.docType
						? UniverStore.docType.replace(/_/g, " ")
						: __("Univer Document Review")
				}}
			</span>
			<button class="btn btn-sm btn-default univer-exit-btn" @click="exitUniver">
				<svg
					width="14"
					height="14"
					viewBox="0 0 16 16"
					fill="none"
					xmlns="http://www.w3.org/2000/svg"
				>
					<use href="#es-line-close" style="--icon-stroke: var(--invert-neutral)" />
				</svg>
				<span>Exit</span>
			</button>
		</div>
		<div v-if="UniverStore.loading" class="univer-message">
			{{ __("Extracting document data...") }}
		</div>
		<div v-else-if="UniverStore.error" class="univer-message univer-error">
			{{ UniverStore.error }}
		</div>
		<div
			v-show="!UniverStore.loading && !UniverStore.error"
			id="univer-container"
			class="univer-container"
		></div>
	</div>
</template>
<script setup>
import { onMounted, onUnmounted, watch } from "vue";
import { useMainStore } from "../../store/MainStore";
import { useUniverStore } from "../../store/UniverStore";

const MainStore = useMainStore();
const UniverStore = useUniverStore();
const containerId = "univer-container";

// the Univer API handle is not reactive, a plain local is enough here
let univerAPI = null;
let workbookBuilt = false;

const buildWorkbook = () => {
	univerAPI.createWorkbook(
		UniverStore.buildWorkbook(UniverStore.docType, UniverStore.extracted)
	);
	workbookBuilt = true;
};

const exitUniver = () => {
	MainStore.mode = "editing";
};

onMounted(() => {
	if (UniverStore.loading || UniverStore.error) return;
	univerAPI = UniverStore.mount(containerId);
	if (UniverStore.extracted && !workbookBuilt) buildWorkbook();
});

watch(
	() => UniverStore.extracted,
	(extracted) => {
		if (!extracted || UniverStore.loading || UniverStore.error) return;
		if (!univerAPI || workbookBuilt) {
			// first mount, or a sheet from a previous extraction is open:
			// mount() disposes the previous instance first
			univerAPI = UniverStore.mount(containerId);
		}
		buildWorkbook();
	}
);

onUnmounted(() => {
	UniverStore.destroy();
	univerAPI = null;
	workbookBuilt = false;
});
</script>
<style deep lang="scss">
.univer-canvas {
	display: flex;
	flex: 1;
	flex-direction: column;
	min-width: 0;
	overflow: hidden;

	.univer-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 8px 16px;
		border-bottom: 1px solid var(--border-color);
		background-color: var(--card-bg);

		.univer-title {
			font-size: var(--text-lg);
			font-weight: var(--weight-semibold);
			text-transform: capitalize;
		}

		.univer-exit-btn {
			display: flex;
			align-items: center;
			gap: 4px;
			padding: 2px 8px;
		}
	}

	.univer-message {
		display: flex;
		flex: 1;
		align-items: center;
		justify-content: center;
		padding: 24px;
		font-size: var(--text-md);
		color: var(--text-muted);
	}

	.univer-error {
		color: var(--danger);
	}

	.univer-container {
		flex: 1;
		min-height: 0;
	}
}
</style>
