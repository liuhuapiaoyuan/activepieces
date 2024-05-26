import {
    FastifyPluginAsyncTypebox,
    Type,
} from '@fastify/type-provider-typebox'
import dayjs from 'dayjs'
import { StatusCodes } from 'http-status-codes'
import { isNil } from 'lodash'
import { entitiesMustBeOwnedByCurrentProject } from '../../authentication/authorization'
import { eventsHooks } from '../../helper/application-events'
import { projectService } from '../../project/project-service'
import { flowService } from './flow.service'
import { ApplicationEventName } from '@activepieces/ee-shared'
import {
    ActivepiecesError,
    ApId,
    CountFlowsRequest,
    CreateFlowRequest,
    ErrorCode,
    FlowOperationRequest,
    FlowOperationType,
    FlowTemplateWithoutProjectInformation,
    GetFlowQueryParamsRequest,
    ListFlowsRequest,
    Permission,
    PopulatedFlow,
    Principal,
    PrincipalType,
    SeekPage,
    SERVICE_KEY_SECURITY_OPENAPI,
} from '@activepieces/shared'
import { projectMemberService } from '../../ee/project-members/project-member.service'
import { assertRoleHasPermission } from '../../ee/authentication/rbac/rbac-middleware'

const DEFAULT_PAGE_SIZE = 10

export const flowController: FastifyPluginAsyncTypebox = async (app) => {
    app.addHook('preSerialization', entitiesMustBeOwnedByCurrentProject)

    app.post('/', CreateFlowRequestOptions, async (request, reply) => {
        const newFlow = await flowService.create({
            projectId: request.principal.projectId,
            request: request.body,
        })

        eventsHooks.get().send(request, {
            action: ApplicationEventName.CREATED_FLOW,
            flow: newFlow,
            userId: request.principal.id,
        })

        return reply.status(StatusCodes.CREATED).send(newFlow)
    })

    app.post('/:id', UpdateFlowRequestOptions, async (request) => {
        const userId = await extractUserIdFromPrincipal(request.principal)
        await assertUserHasPermissionToFlow(request.principal, userId, request.body.type)

        const flow = await flowService.getOnePopulatedOrThrow({
            id: request.params.id,
            projectId: request.principal.projectId,
        })
        await assertThatFlowIsNotBeingUsed(flow, userId)
        eventsHooks.get().send(request, {
            action: ApplicationEventName.UPDATED_FLOW,
            request: request.body,
            flow,
            userId: request.principal.id,
        })

        const updatedFlow = await flowService.update({
            id: request.params.id,
            userId: request.principal.type === PrincipalType.SERVICE ? null : userId,
            projectId: request.principal.projectId,
            operation: request.body,
        })
        return updatedFlow
    })

    app.get('/', ListFlowsRequestOptions, async (request) => {
        return flowService.list({
            projectId: request.principal.projectId,
            folderId: request.query.folderId,
            cursorRequest: request.query.cursor ?? null,
            limit: request.query.limit ?? DEFAULT_PAGE_SIZE,
            status: request.query.status,
        })
    })

    app.get('/count', CountFlowsRequestOptions, async (request) => {
        return flowService.count({
            folderId: request.query.folderId,
            projectId: request.principal.projectId,
        })
    })

    app.get('/:id/template', GetFlowTemplateRequestOptions, async (request) => {
        return flowService.getTemplate({
            flowId: request.params.id,
            projectId: request.principal.projectId,
            versionId: undefined,
        })
    })

    app.get('/:id', GetFlowRequestOptions, async (request) => {
        return flowService.getOnePopulatedOrThrow({
            id: request.params.id,
            projectId: request.principal.projectId,
            versionId: request.query.versionId,
        })
    })

    app.delete('/:id', DeleteFlowRequestOptions, async (request, reply) => {
        const flow = await flowService.getOnePopulatedOrThrow({
            id: request.params.id,
            projectId: request.principal.projectId,
        })
        const userId = await extractUserIdFromPrincipal(request.principal)
        eventsHooks.get().send(request, {
            action: ApplicationEventName.DELETED_FLOW,
            flow,
            userId,
        })
        await flowService.delete({
            id: request.params.id,
            projectId: request.principal.projectId,
        })
        return reply.status(StatusCodes.NO_CONTENT).send()
    })
}

async function assertUserHasPermissionToFlow(
    principal: Principal,
    userId: string,
    operationType: FlowOperationType,
): Promise<void> {
    const role = await projectMemberService.getRole({
        projectId: principal.projectId,
        userId,
    })
    switch (operationType) {
        case FlowOperationType.LOCK_AND_PUBLISH:
        case FlowOperationType.CHANGE_STATUS: {
            await assertRoleHasPermission(principal, Permission.UPDATE_FLOW_STATUS)
            break;
        }
        case FlowOperationType.ADD_ACTION:
        case FlowOperationType.UPDATE_ACTION:
        case FlowOperationType.DELETE_ACTION:
        case FlowOperationType.LOCK_FLOW:
        case FlowOperationType.CHANGE_FOLDER:
        case FlowOperationType.CHANGE_NAME:
        case FlowOperationType.MOVE_ACTION:
        case FlowOperationType.IMPORT_FLOW:
        case FlowOperationType.UPDATE_TRIGGER:
        case FlowOperationType.DUPLICATE_ACTION:
        case FlowOperationType.USE_AS_DRAFT: {
            await assertRoleHasPermission(principal, Permission.WRITE_FLOW)
            break;
        }
    }
}

async function assertThatFlowIsNotBeingUsed(
    flow: PopulatedFlow,
    userId: string,
): Promise<void> {
    const currentTime = dayjs()
    if (
        !isNil(flow.version.updatedBy) &&
        flow.version.updatedBy !== userId &&
        currentTime.diff(dayjs(flow.version.updated), 'minute') <= 1
    ) {
        throw new ActivepiecesError({
            code: ErrorCode.FLOW_IN_USE,
            params: {
                flowVersionId: flow.version.id,
                message: 'Flow is being used by another user in the last minute. Please try again later.',
            },
        })
    }
}

async function extractUserIdFromPrincipal(
    principal: Principal,
): Promise<string> {
    if (principal.type === PrincipalType.USER) {
        return principal.id
    }
    // TODO currently it's same as api service, but it's better to get it from api key service, in case we introduced more admin users
    const project = await projectService.getOneOrThrow(principal.projectId)
    return project.ownerId
}

const CreateFlowRequestOptions = {
    config: {
        allowedPrincipals: [PrincipalType.USER, PrincipalType.SERVICE],
        permission: Permission.WRITE_FLOW,
    },
    schema: {
        tags: ['flows'],
        description: 'Create a flow',
        security: [SERVICE_KEY_SECURITY_OPENAPI],
        body: CreateFlowRequest,
        response: {
            [StatusCodes.CREATED]: PopulatedFlow,
        },
    },
}

const UpdateFlowRequestOptions = {
    config: {
        permission: Permission.WRITE_FLOW,
    },
    schema: {
        tags: ['flows'],
        description: 'Apply an operation to a flow',
        security: [SERVICE_KEY_SECURITY_OPENAPI],
        body: FlowOperationRequest,
        params: Type.Object({
            id: ApId,
        }),
    },
}

const ListFlowsRequestOptions = {
    config: {
        allowedPrincipals: [PrincipalType.USER, PrincipalType.SERVICE],
        permission: Permission.READ_FLOW,
    },
    schema: {
        tags: ['flows'],
        description: 'List flows',
        security: [SERVICE_KEY_SECURITY_OPENAPI],
        querystring: ListFlowsRequest,
        response: {
            [StatusCodes.OK]: SeekPage(PopulatedFlow),
        },
    },
}

const CountFlowsRequestOptions = {
    schema: {
        querystring: CountFlowsRequest,
    },
}

const GetFlowTemplateRequestOptions = {
    schema: {
        params: Type.Object({
            id: ApId,
        }),
        response: {
            [StatusCodes.OK]: FlowTemplateWithoutProjectInformation,
        },
    },
}

const GetFlowRequestOptions = {
    config: {
        allowedPrincipals: [PrincipalType.USER, PrincipalType.SERVICE],
        permission: Permission.READ_FLOW,
    },
    schema: {
        tags: ['flows'],
        security: [SERVICE_KEY_SECURITY_OPENAPI],
        description: 'Get a flow by id',
        params: Type.Object({
            id: ApId,
        }),
        querystring: GetFlowQueryParamsRequest,
        response: {
            [StatusCodes.OK]: PopulatedFlow,
        },
    },
}

const DeleteFlowRequestOptions = {
    config: {
        allowedPrincipals: [PrincipalType.USER, PrincipalType.SERVICE],
        permission: Permission.WRITE_FLOW,
    },
    schema: {
        tags: ['flows'],
        security: [SERVICE_KEY_SECURITY_OPENAPI],
        description: 'Delete a flow',
        params: Type.Object({
            id: ApId,
        }),
        response: {
            [StatusCodes.NO_CONTENT]: Type.Undefined(),
        },
    },
}
