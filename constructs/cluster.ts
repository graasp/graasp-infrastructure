import {
  AppautoscalingPolicy,
  AppautoscalingPolicyTargetTrackingScalingPolicyConfiguration,
} from '@cdktf/provider-aws/lib/appautoscaling-policy';
import { AppautoscalingTarget } from '@cdktf/provider-aws/lib/appautoscaling-target';
import { CloudwatchLogGroup } from '@cdktf/provider-aws/lib/cloudwatch-log-group';
import { EcsCluster } from '@cdktf/provider-aws/lib/ecs-cluster';
import { EcsClusterCapacityProviders } from '@cdktf/provider-aws/lib/ecs-cluster-capacity-providers';
import {
  EcsService,
  EcsServiceCapacityProviderStrategy,
  EcsServiceLoadBalancer,
} from '@cdktf/provider-aws/lib/ecs-service';
import { EcsTaskDefinition } from '@cdktf/provider-aws/lib/ecs-task-definition';
import { IamRole } from '@cdktf/provider-aws/lib/iam-role';
import { IamRolePolicy } from '@cdktf/provider-aws/lib/iam-role-policy';
import { LbListenerRule } from '@cdktf/provider-aws/lib/lb-listener-rule';
import { LbTargetGroup } from '@cdktf/provider-aws/lib/lb-target-group';
import { SecurityGroup } from '@cdktf/provider-aws/lib/security-group';
import { ServiceDiscoveryHttpNamespace } from '@cdktf/provider-aws/lib/service-discovery-http-namespace';
import { Fn, Token } from 'cdktf';

import { Construct } from 'constructs';

import { Vpc } from '../.gen/modules/vpc';
import {
  EnvironmentConfig,
  SpotPreference,
  SpotPreferenceOptions,
} from '../utils';
import { LoadBalancer } from './load_balancer';

type TaskDefinitionConfiguration = {
  containerDefinitions: string;
  cpu?: string;
  memory?: string;
  dummy: boolean;
};

export class Cluster extends Construct {
  cluster: EcsCluster;
  vpc: Vpc;
  namespace: ServiceDiscoveryHttpNamespace;
  executionRole: IamRole;

  constructor(scope: Construct, name: string, vpc: Vpc) {
    super(scope, name);
    this.cluster = new EcsCluster(scope, `cluster`, {
      name,
    });
    this.vpc = vpc;
    this.namespace = new ServiceDiscoveryHttpNamespace(this, 'namespace', {
      description: 'Namespace for internal communication between services',
      name: 'graasp',
    });

    const executionRoleName = `${name}-ecs-execution-role`;
    this.executionRole = new IamRole(this, `ecs-execution-role`, {
      name: executionRoleName,
      // this role shall only be used by an ECS task
      assumeRolePolicy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Sid: '',
            Principal: {
              Service: 'ecs-tasks.amazonaws.com',
            },
          },
        ],
      }),
    });
    const executionRolePoliciesName = `${name}-ecs-execution-role-policies`;
    new IamRolePolicy(this, executionRolePoliciesName, {
      name: 'allow-ecr-pull',
      policy: Token.asString(
        Fn.jsonencode({
          Statement: [
            {
              Effect: 'Allow',
              Action: [
                'ecr:GetAuthorizationToken',
                'ecr:BatchCheckLayerAvailability',
                'ecr:GetDownloadUrlForLayer',
                'ecr:BatchGetImage',
                'logs:CreateLogStream',
                'logs:PutLogEvents',
              ],
              Resource: '*',
            },
          ],
          Version: '2012-10-17',
        }),
      ),
      role: this.executionRole.id,
    });
    // setup cluster capacity providers (allows to use fargate spot)
    new EcsClusterCapacityProviders(this, `${name}-ecs-capacity-providers`, {
      clusterName: this.cluster.name,
      capacityProviders: ['FARGATE_SPOT', 'FARGATE'],
      defaultCapacityProviderStrategy: [
        {
          base: 1,
          weight: 100,
          capacityProvider: 'FARGATE',
        },
      ],
    });
  }

  private getCapacityProviderStrategy(
    spotPreference: SpotPreferenceOptions,
    desiredCount: number = 1,
  ): EcsServiceCapacityProviderStrategy[] {
    switch (spotPreference) {
      case SpotPreference.NoSpot:
        return [
          {
            capacityProvider: 'FARGATE',
            base: desiredCount,
            weight: 100,
          },
        ];
      case SpotPreference.UpscaleWithSpot:
        return [
          {
            capacityProvider: 'FARGATE',
            base: 1,
            weight: 1,
          },
          {
            capacityProvider: 'FARGATE_SPOT',
          },
        ];
      case SpotPreference.OnlySpot:
        return [{ capacityProvider: 'FARGATE_SPOT', weight: 1 }];
    }
  }

  public addService(
    name: string,
    desiredCount: number,
    // defines the preference for running on spot instances (cheaper)
    // set to ' disabled' if it should not use spot instances at all
    // set to 'upscale' if you would like to have one instance on standard and all other instances on spot
    // set to 'all' to use only spot instances (requires the service to be fault tolerant and stateless)
    spotPreference: SpotPreferenceOptions,
    taskDefinitionConfig: TaskDefinitionConfiguration,
    serviceSecurityGroup: SecurityGroup,
    internalNamespaceExpose?: { name: string; port: number },
    appAutoscalingConfig?: AppautoscalingPolicyTargetTrackingScalingPolicyConfiguration,
    loadBalancerConfig?: {
      loadBalancer: LoadBalancer;
      priority: number;
      port: number;
      containerPort: number;
      host: string;
      healthCheckPath: string;
    },
  ) {
    new CloudwatchLogGroup(this, `${name}-loggroup`, {
      name: `/ecs/${name}`,
      retentionInDays: 30,
    });

    const task = new EcsTaskDefinition(this, name, {
      family: name, // name used to group the definitions versions

      cpu: taskDefinitionConfig.cpu ?? '256',
      memory: taskDefinitionConfig.memory ?? '512',
      requiresCompatibilities: ['FARGATE'],
      networkMode: 'awsvpc',
      executionRoleArn: this.executionRole.arn,
      containerDefinitions: taskDefinitionConfig.containerDefinitions,

      lifecycle: {
        ignoreChanges: taskDefinitionConfig.dummy ? 'all' : undefined,
      },
    });

    let ecsServiceLoadBalancerOptions: EcsServiceLoadBalancer[] | undefined;

    // If exposed on load balancer
    if (loadBalancerConfig) {
      const targetGroup = new LbTargetGroup(this, `${name}-target-group`, {
        dependsOn: [loadBalancerConfig.loadBalancer.lbl],
        name: `${name}`,
        port: loadBalancerConfig.port,
        protocol: 'HTTP',
        targetType: 'ip',
        vpcId: this.vpc.vpcIdOutput,
        healthCheck: {
          enabled: true,
          path: loadBalancerConfig.healthCheckPath,
          healthyThreshold: 3,
          unhealthyThreshold: 3,
          timeout: 6, // in seconds the response time after which the target is considered un-healthy
          interval: 60, // in seconds
        },
      });

      ecsServiceLoadBalancerOptions = [
        {
          containerPort: loadBalancerConfig.containerPort,
          containerName: name,
          targetGroupArn: targetGroup.arn,
        },
      ];

      // Makes the listener forward requests from host to the target group
      new LbListenerRule(this, `${name}-rule`, {
        listenerArn: loadBalancerConfig.loadBalancer.lbl.arn,
        priority: loadBalancerConfig.priority,
        action: [
          {
            type: 'forward',
            targetGroupArn: targetGroup.arn,
          },
        ],

        condition: [
          {
            hostHeader: {
              values: [loadBalancerConfig.host],
            },
          },
        ],
      });
    }

    // define capacity provider strategy
    const capacityProviderStrategy = this.getCapacityProviderStrategy(
      spotPreference,
      desiredCount,
    );

    // add service inside cluster
    const service = new EcsService(this, `${name}-service`, {
      name,
      cluster: this.cluster.id,
      desiredCount: desiredCount,
      capacityProviderStrategy,
      deploymentMinimumHealthyPercent: 100,
      deploymentMaximumPercent: 200,
      taskDefinition: task.arn,
      networkConfiguration: {
        subnets: Fn.tolist(this.vpc.publicSubnetsOutput),
        assignPublicIp: true,
        securityGroups: [serviceSecurityGroup.id],
      },
      loadBalancer: ecsServiceLoadBalancerOptions,
      serviceConnectConfiguration: {
        enabled: true,
        namespace: this.namespace.arn,
        service: internalNamespaceExpose
          ? [
              {
                portName: `${name}-${internalNamespaceExpose.port}-tcp`,
                clientAlias: {
                  dnsName: internalNamespaceExpose.name,
                  port: internalNamespaceExpose.port,
                },
                discoveryName: internalNamespaceExpose.name,
              },
            ]
          : undefined,
      },
      lifecycle: taskDefinitionConfig.dummy
        ? {
            ignoreChanges: ['task_definition'],
          }
        : undefined,
    });

    if (appAutoscalingConfig) {
      const scalingTarget = new AppautoscalingTarget(
        this,
        `${name}-service-autoscaling-target`,
        {
          minCapacity: desiredCount,
          maxCapacity: 8,
          resourceId: `service/${this.cluster.name}/${service.name}`,
          scalableDimension: 'ecs:service:DesiredCount',
          serviceNamespace: 'ecs',
        },
      );
      new AppautoscalingPolicy(this, `${name}-service-autoscaling-policy`, {
        name: service.name,
        policyType: 'TargetTrackingScaling',
        resourceId: scalingTarget.resourceId,
        scalableDimension: scalingTarget.scalableDimension,
        serviceNamespace: scalingTarget.serviceNamespace,
        targetTrackingScalingPolicyConfiguration: appAutoscalingConfig,
      });
    }

    return task;
  }
}

export function createContainerDefinitions(
  name: string,
  dockerImage: string,
  dockerTag: string,
  portMappings: {
    containerPort: number;
    hostPort: number;
  }[],
  env: Record<string, string | undefined>,
  deployEnv: EnvironmentConfig,
  command?: string[],
): string {
  return JSON.stringify([
    {
      name,
      image: `${dockerImage}:${dockerTag}`,
      environment: Object.entries(env).map(([name, value]) => ({
        name,
        value,
      })),
      portMappings: portMappings.map((m) => ({
        ...m,
        name: `${name}-${m.hostPort}-tcp`,
      })),
      command: command,
      logConfiguration: {
        logDriver: 'awslogs',
        options: {
          'awslogs-group': `/ecs/${name}`,
          'awslogs-region': deployEnv.region,
          'awslogs-stream-prefix': 'ecs',
        },
      },
    },
  ]);
}
