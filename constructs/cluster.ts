import {
  AppautoscalingPolicy,
  AppautoscalingPolicyTargetTrackingScalingPolicyConfiguration,
} from '@cdktf/provider-aws/lib/appautoscaling-policy';
import { AppautoscalingTarget } from '@cdktf/provider-aws/lib/appautoscaling-target';
import { CloudwatchLogGroup } from '@cdktf/provider-aws/lib/cloudwatch-log-group';
import { DataAwsEcsTaskExecution } from '@cdktf/provider-aws/lib/data-aws-ecs-task-execution';
import { EcsCluster } from '@cdktf/provider-aws/lib/ecs-cluster';
import {
  EcsService,
  EcsServiceLoadBalancer,
} from '@cdktf/provider-aws/lib/ecs-service';
import { EcsTaskDefinition } from '@cdktf/provider-aws/lib/ecs-task-definition';
import { IamRole } from '@cdktf/provider-aws/lib/iam-role';
import { IamRolePolicy } from '@cdktf/provider-aws/lib/iam-role-policy';
import {
  LbListenerRule,
  LbListenerRuleCondition,
} from '@cdktf/provider-aws/lib/lb-listener-rule';
import { LbTargetGroup } from '@cdktf/provider-aws/lib/lb-target-group';
import { SecurityGroup } from '@cdktf/provider-aws/lib/security-group';
import { ServiceDiscoveryHttpNamespace } from '@cdktf/provider-aws/lib/service-discovery-http-namespace';
import { Fn, Token } from 'cdktf';

import { Construct } from 'constructs';

import { Vpc } from '../.gen/modules/vpc';
import { EnvironmentConfig } from '../utils';
import { LoadBalancer } from './load_balancer';

type PortMapping = { containerPort: number; hostPort: number };
type ContainerDefinition = {
  name: string;
  image: string;
  environment: { name: string; value: string | undefined }[];
  portMappings: (PortMapping & { name: string })[];
  command: string[] | undefined;
  logConfiguration: {
    logDriver: 'awslogs';
    options: {
      'awslogs-group': string;
      'awslogs-region': string;
      'awslogs-stream-prefix': string;
    };
  };
};
type TaskDefinitionConfiguration = {
  containerDefinitions: ContainerDefinition[];
  cpu?: string;
  memory?: string;
  cpuArchitecture?: 'X86_64' | 'ARM64';
};

export function portMappingRange({ from, to }: { from: number; to: number }) {
  return Array.from({ length: to - from + 1 }, (_, i) => ({
    containerPort: from + i,
    hostPort: from + i,
    protocol: 'tcp',
  }));
}

export function createContainerDefinitions(
  name: string,
  dockerImage: string,
  dockerTag: string,
  portMappings: PortMapping[],
  env: Record<string, string | undefined>,
  deployEnv: EnvironmentConfig,
  command?: string[],
): ContainerDefinition {
  return {
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
  };
}

export class Cluster extends Construct {
  cluster: EcsCluster;
  vpc: Vpc;
  namespace: ServiceDiscoveryHttpNamespace;
  executionRole: IamRole;

  constructor(scope: Construct, name: string, vpc: Vpc) {
    super(scope, name);

    this.cluster = new EcsCluster(scope, `cluster`, { name });
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
            Principal: { Service: 'ecs-tasks.amazonaws.com' },
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
  }

  public addService(
    {
      name,
      desiredCount,
      enableExecuteCommand,
    }: {
      name: string;
      desiredCount: number;
      enableExecuteCommand?: boolean;
    },
    taskDefinitionConfig: TaskDefinitionConfiguration,
    isActive: boolean,
    serviceSecurityGroup: SecurityGroup,
    internalNamespaceExpose?: { name: string; port: number },
    appAutoscalingConfig?: AppautoscalingPolicyTargetTrackingScalingPolicyConfiguration,
    loadBalancerConfig?: {
      loadBalancer: LoadBalancer;
      priority: number;
      port: number;
      containerPort: number;
      containerName: string;
      host: string;
      healthCheckPath: string;
      ruleConditions?: LbListenerRuleCondition[];
    },
  ) {
    // create a log stream for each container in the task def
    for (const {
      name: containerName,
      logConfiguration,
    } of taskDefinitionConfig.containerDefinitions) {
      new CloudwatchLogGroup(this, `${name}-${containerName}-loggroup`, {
        name: logConfiguration.options['awslogs-group'],
        retentionInDays: 30,
      });
    }

    const task = new EcsTaskDefinition(this, name, {
      family: name, // name used to group the definitions versions
      cpu: taskDefinitionConfig.cpu ?? '256',
      memory: taskDefinitionConfig.memory ?? '512',
      runtimePlatform: {
        operatingSystemFamily: 'LINUX',
        cpuArchitecture: taskDefinitionConfig.cpuArchitecture ?? 'X86_64',
      },
      requiresCompatibilities: ['FARGATE'],
      networkMode: 'awsvpc',
      // this allows to execute commands inside the container via the aws cli
      taskRoleArn: enableExecuteCommand
        ? this.createECSExecTaskRole(name).arn
        : undefined,
      executionRoleArn: this.executionRole.arn,
      containerDefinitions: JSON.stringify(
        taskDefinitionConfig.containerDefinitions,
      ),
      tags: {},
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
          containerName: loadBalancerConfig.containerName,
          targetGroupArn: targetGroup.arn,
        },
      ];

      // Makes the listener forward requests from host to the target group
      new LbListenerRule(this, `${name}-rule`, {
        listenerArn: loadBalancerConfig.loadBalancer.lbl.arn,
        priority: loadBalancerConfig.priority,
        action: [{ type: 'forward', targetGroupArn: targetGroup.arn }],

        condition: [
          { hostHeader: { values: [loadBalancerConfig.host] } },
          // add rule conditions
          ...(loadBalancerConfig.ruleConditions ?? []),
        ],
      });
    }

    // add service inside cluster

    const service = new EcsService(this, `${name}-service`, {
      name,
      launchType: 'FARGATE',
      cluster: this.cluster.id,
      desiredCount: isActive ? desiredCount : 0,
      deploymentMinimumHealthyPercent: 100,
      deploymentMaximumPercent: 200,
      taskDefinition: task.arn,
      networkConfiguration: {
        subnets: Fn.tolist(this.vpc.publicSubnetsOutput),
        assignPublicIp: true,
        securityGroups: [serviceSecurityGroup.id],
      },
      enableExecuteCommand: enableExecuteCommand ?? false,
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

  private createECSExecTaskRole(name: string) {
    const taskRole = new IamRole(this, `${name}-ecsExec-task-role`, {
      name: `${name}-ecsExec-task-role`,
      // this role shall only be used by an ECS task
      assumeRolePolicy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Sid: '',
            Principal: { Service: 'ecs-tasks.amazonaws.com' },
          },
        ],
      }),
    });
    new IamRolePolicy(this, `${name}-ecsExec-task-policy`, {
      name: `${name}-allow-ecsExec-task-policy`,
      role: taskRole.id,
      policy: Token.asString(
        Fn.jsonencode({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Action: [
                'ssmmessages:CreateControlChannel',
                'ssmmessages:CreateDataChannel',
                'ssmmessages:OpenControlChannel',
                'ssmmessages:OpenDataChannel',
              ],
              Resource: '*',
            },
          ],
        }),
      ),
    });
    return taskRole;
  }

  public addOneOffTask(
    name: string,
    desiredCount: number,
    isActive: boolean,
    taskDefinitionConfig: TaskDefinitionConfiguration,
    serviceSecurityGroup: SecurityGroup,
  ) {
    new CloudwatchLogGroup(this, `${name}-loggroup`, {
      name: `/ecs/${name}`,
      retentionInDays: 7,
    });

    const taskDef = new EcsTaskDefinition(this, `${name}-task-definition`, {
      family: name,
      containerDefinitions: JSON.stringify(
        taskDefinitionConfig.containerDefinitions,
      ),
      cpu: taskDefinitionConfig.cpu ?? '256',
      memory: taskDefinitionConfig.memory ?? '512',
      requiresCompatibilities: ['FARGATE'],
      networkMode: 'awsvpc',
      executionRoleArn: this.executionRole.arn,
    });

    if (isActive) {
      const task = new DataAwsEcsTaskExecution(this, name, {
        cluster: Token.asString(this.cluster.arn),
        taskDefinition: Token.asString(taskDef.arn),
        desiredCount,
        launchType: 'FARGATE',
        networkConfiguration: {
          subnets: Fn.tolist(this.vpc.publicSubnetsOutput),
          assignPublicIp: true,
          securityGroups: [serviceSecurityGroup.id],
        },
      });

      return task;
    }
    return undefined;
  }
}
